
const { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } = React;

/* -- Safe number formatters ----------------------------------------- */
function fmtNum(v, decimals) {
  const n = parseFloat(v);
  if (isNaN(n)) return "—";
  return n.toLocaleString("tr-TR", { minimumFractionDigits: decimals||0, maximumFractionDigits: decimals||0 });
}
function fmtMoney(v, currency) {
  const n = parseFloat(v);
  if (isNaN(n)) return "—";
  const sym = currency === "TRY" ? "₺" : currency === "USD" ? "$" : "€";
  return sym + n.toLocaleString("tr-TR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function safeNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
/* Safe percentage helpers: never produce NaN/%NaN/Infinity. Zero (or
   invalid) denominator → 0, per the project-wide convention. */
function safePctNum(numerator, denominator) {
  const num = parseFloat(numerator), den = parseFloat(denominator);
  if (!den || isNaN(den) || isNaN(num)) return 0;
  const pct = (num / den) * 100;
  return isFinite(pct) ? Math.round(pct) : 0;
}
function safePct(numerator, denominator) {
  return safePctNum(numerator, denominator) + "%";
}


const ROUTER_STATE = { setPath: null };

function useBreakpoint() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1440);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return {
    w,
    isMobile:  w < 768,
    isTablet:  w >= 768 && w < 1024,
    isDesktop: w >= 1024,
    is390:     w < 430,
  };
}

function getHashPath() {
  try {
    const h = window.location.hash.replace(/^#\/?/, '') || 'dashboard';
    return h.startsWith('/') ? h : '/' + h;
  } catch(e) { return '/dashboard'; }
}

function useHashRouter() {
  const [path, setPath] = useState(getHashPath);

  // navigate is stable — uses ref to avoid stale closures
  const setPathRef = useRef(setPath);
  useEffect(() => { setPathRef.current = setPath; }, [setPath]);

  // Single canonical navigate function — never circular
  const navigate = useCallback((to) => {
    if (!to) return;
    const newPath = to.startsWith('/') ? to : '/' + to;
    try { window.location.hash = '#' + newPath; } catch(e) {}
    setPathRef.current(newPath);
  }, []);

  useEffect(() => {
    // Register for external callers (repos, modals, etc.)
    NAV_REF.fn         = navigate;
    ROUTER_STATE.setPath = navigate;

    function onHashChange() {
      const p = getHashPath();
      setPathRef.current(p);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      // Keep NAV_REF alive so late async callbacks don't throw
    };
  }, [navigate]);

  const segs = path.replace(/^\//, '').split('/').filter(Boolean);
  return { path, base: segs[0] || 'dashboard', param: segs[1] || null, navigate };
}

const C = {
  navy:"#1B2D4F", navyDeep:"#0F1D35", navyHover:"#243660",
  gold:"#B8973A", goldLight:"#C9A84C", goldPale:"#F5EDD4",
  ivory:"#F8F5EE", ivoryDark:"#EDE9DF", white:"#FFFFFF",
  border:"#E4DDD0", borderLight:"#EDE9DF",
  text:"#1B2D4F", textMid:"#4A5568", textMuted:"#8A8070", textFaint:"#B0A898",
  green:"#2E7D52", greenBg:"#EBF5EF",
  red:"#C0392B", redBg:"#FDECEC",
  amber:"#B45309", amberBg:"#FEF3E2",
  blue:"#1A6FAE", blueBg:"#E8F2FB",
  orange:"#C05621", orangeBg:"#FEF0E8",
};

const DB = {

  staff: [
    { id:"STAFF-001", name:"Berk Çetinkaya", initials:"BÇ", email:"berk@desetour.com",   role:"Yönetici",  active:true },
    { id:"STAFF-002", name:"Selin Kaya",     initials:"SK", email:"selin@desetour.com",  role:"Satış",     active:true },
    { id:"STAFF-003", name:"Murat Demir",    initials:"MD", email:"murat@desetour.com",  role:"Operasyon", active:true },
    { id:"STAFF-004", name:"Zeynep Arslan",  initials:"ZA", email:"zeynep@desetour.com", role:"Rehber",    active:false },
  ],

  sources: [
    { id:"SRC-01", slug:"website",     label:"Website",     active:true  },
    { id:"SRC-02", slug:"whatsapp",    label:"WhatsApp",    active:true  },
    { id:"SRC-03", slug:"telefon",     label:"Telefon",     active:true  },
    { id:"SRC-04", slug:"instagram",   label:"Instagram",   active:true  },
    { id:"SRC-05", slug:"facebook",    label:"Facebook",    active:true  },
    { id:"SRC-06", slug:"booking",     label:"Booking",     active:true  },
    { id:"SRC-07", slug:"tripadvisor", label:"Tripadvisor", active:false },
    { id:"SRC-08", slug:"email",       label:"Email",       active:true  },
    { id:"SRC-09", slug:"manuel",      label:"Manuel",      active:true  },
    { id:"SRC-10", slug:"civitatis",   label:"Civitatis",   active:true  },
  ],

  tours: [
    {
      id:"TUR-001", name:"Private Istanbul Experience", category:"Özel Tur",
      duration:"8 Saat", pricingType:"Kişi Bazlı", basePrice:180, currency:"EUR",
      status:"Aktif", updatedAt:"03 Haz 2026", usageCount:18,
      description:"Özel rehber eşliğinde İstanbul'un ikonik mekanlarını keşfedin.",
      included:["Lisanslı Özel Rehber","Otel Karşılama","Tüm Giriş Ücretleri","Öğle Yemeği","Özel Ulaşım","Su ve İkramlar"],
      excluded:["Kişisel Harcamalar","Alkollü İçecekler","Bahşiş","Belirtilmeyen Aktiviteler"],
      tiers:{1:180,2:240,3:300,4:360,5:420,6:480,7:520,8:560},
      ops:{pickup:true,vehicle:true,guide:true,defaultNotes:"VIP misafirler için özel düzenlemeler yapılabilir."},
    },
    {
      id:"TUR-002", name:"Bosphorus & Asian Side Tour", category:"Tekne Turu",
      duration:"6 Saat", pricingType:"Kişi Bazlı", basePrice:150, currency:"EUR",
      status:"Aktif", updatedAt:"02 Haz 2026", usageCount:11,
      description:"Boğaz turu ile Avrupa ve Asya kıtaları arasında unutulmaz deneyim.",
      included:["Lisanslı Rehber","Özel Tekne Turu","Kahvaltı","Otel Karşılama"],
      excluded:["Öğle Yemeği","Kişisel Harcamalar"],
      tiers:{1:150,2:200,3:260,4:320,5:380,6:440,7:490,8:530},
      ops:{pickup:true,vehicle:true,guide:true,defaultNotes:"Tekne büyüklüğü kişi sayısına göre belirlenir."},
    },
    {
      id:"TUR-003", name:"Old City Highlights Tour", category:"Kültürel Tur",
      duration:"5 Saat", pricingType:"Kişi Bazlı", basePrice:90, currency:"EUR",
      status:"Aktif", updatedAt:"01 Haz 2026", usageCount:9,
      description:"Sultanahmet bölgesinin en önemli tarihi alanları.",
      included:["Lisanslı Rehber","Tüm Giriş Ücretleri","Ayasofya","Topkapı Sarayı","Kapalıçarşı"],
      excluded:["Yemekler","Kişisel Ulaşım","Kişisel Harcamalar"],
      tiers:{1:90,2:150,3:200,4:260,5:310,6:360,7:400,8:440},
      ops:{pickup:false,vehicle:false,guide:true,defaultNotes:"Sultanahmet'te buluşma noktası belirlenir."},
    },
    {
      id:"TUR-004", name:"Cappadocia Full Experience", category:"Macera Turu",
      duration:"2 Gün", pricingType:"Sabit Fiyat", basePrice:450, flatPrice:450, currency:"EUR",
      status:"Aktif", updatedAt:"28 May 2026", usageCount:4,
      description:"Kapadokya'nın peri bacaları, balon turu ve yeraltı şehirleri.",
      included:["Balon Turu","Lisanslı Rehber","2 Öğün Yemek","Konaklama Transferi"],
      excluded:["Uçuş","Konaklama","Kişisel Harcamalar"],
      tiers:null,
      ops:{pickup:true,vehicle:true,guide:true,defaultNotes:"Kapadokya'ya uçuş ayrıca planlanmalı."},
    },
    {
      id:"TUR-005", name:"Istanbul Food & Culture Tour", category:"Gastronomi",
      duration:"4 Saat", pricingType:"Sabit Fiyat", basePrice:280, flatPrice:280, currency:"EUR",
      status:"Taslak", updatedAt:"03 Haz 2026", usageCount:0,
      description:"İstanbul'un en autentik sokak lezzetleri ve gizli mutfak hazineleri.",
      included:["Profesyonel Rehber","Tüm Tadım Ücretleri","6+ Yemek Durağı"],
      excluded:["Ek Yemekler","Kişisel Harcamalar"],
      tiers:null,
      ops:{pickup:false,vehicle:false,guide:true,defaultNotes:"Yürüyüş turu."},
    },
    {
      id:"TUR-006", name:"Classic Half Day Tour", category:"Gün Turu",
      duration:"4 Saat", pricingType:"Kişi Bazlı", basePrice:65, currency:"EUR",
      status:"Arşiv", updatedAt:"10 May 2026", usageCount:3,
      description:"Kısa sürede İstanbul'un en önemli alanlarını kapsayan ekonomik tur.",
      included:["Rehber","Temel Giriş Ücretleri"],
      excluded:["Yemekler","Ulaşım"],
      tiers:{1:65,2:100,3:140,4:180,5:210,6:240},
      ops:{pickup:false,vehicle:false,guide:true,defaultNotes:""},
    },
  ],

  customers: [
    {
      id:"CUST-001", name:"Sarah Johnson",  initials:"SJ", flag:"🇦🇺", country:"Avustralya", language:"İngilizce",
      phone:"+61 412 855 903", email:"sarah.johnson@email.com",
      sourceId:"SRC-06", firstContact:"03 Haz 2026", lastContact:"Dün",
      status:"Teklif Bekliyor", tags:["VIP","Yeni"],
      notes:"Boğaz turu seçeneğiyle ilgileniyor. Özel deneyimler tercih ediyor. VIP misafir.",
    },
    {
      id:"CUST-002", name:"Emma Brown",    initials:"EB", flag:"🇺🇸", country:"ABD",         language:"İngilizce",
      phone:"+1 310 555 0192", email:"emma.brown@email.com",
      sourceId:"SRC-02", firstContact:"01 Haz 2026", lastContact:"Bugün",
      status:"Rezervasyonu Var", tags:["Grup"],
      notes:"6 kişilik grup. Ekstra su ve ikram hazırlanacak.",
    },
    {
      id:"CUST-003", name:"Ayşe Demir",   initials:"AD", flag:"🇹🇷", country:"Türkiye",     language:"Türkçe",
      phone:"+90 532 111 2233", email:"ayse.demir@email.com",
      sourceId:"SRC-03", firstContact:"02 Haz 2026", lastContact:"2 gün önce",
      status:"Aktif", tags:["Balayı","VIP"],
      notes:"Balayı çifti. Sürpriz çiçek ve şampanya organizasyonu istendi.",
    },
    {
      id:"CUST-004", name:"John Smith",   initials:"JS", flag:"🇬🇧", country:"İngiltere",   language:"İngilizce",
      phone:"+44 7700 900 856", email:"john.smith@email.com",
      sourceId:"SRC-01", firstContact:"15 May 2026", lastContact:"1 hafta önce",
      status:"Tekrar Gelen", tags:["Tekrar Gelen","İndirim"],
      notes:"3. ziyareti. Her seyahatte farklı tur deniyor.",
    },
    {
      id:"CUST-005", name:"Yuki Tanaka",  initials:"YT", flag:"🇯🇵", country:"Japonya",     language:"İngilizce",
      phone:"+81 90 1234 5678", email:"yuki.tanaka@email.com",
      sourceId:"SRC-09", firstContact:"02 Haz 2026", lastContact:"3 gün önce",
      status:"Rezervasyonu Var", tags:["Yeni","Fotoğraf"],
      notes:"Japonca rehber tercihi var. Fotoğrafçılıkla ilgileniyor.",
    },
    {
      id:"CUST-006", name:"Michael Green",initials:"MG", flag:"🇬🇧", country:"İngiltere",   language:"İngilizce",
      phone:"+44 7911 123 456", email:"michael.green@email.com",
      sourceId:"SRC-01", firstContact:"03 Haz 2026", lastContact:"Bugün",
      status:"Aktif", tags:["Yeni"],
      notes:"Website üzerinden Old City Tour talebi.",
    },
    {
      id:"CUST-007", name:"Luca Rossi",   initials:"LR", flag:"🇮🇹", country:"İtalya",      language:"İngilizce",
      phone:"+39 333 123 4567", email:"luca.rossi@email.com",
      sourceId:"SRC-04", firstContact:"30 May 2026", lastContact:"5 saat önce",
      status:"Aktif", tags:[],
      notes:"Old City tour, 2 kişi.",
    },
    {
      id:"CUST-008", name:"Olivia Carter",initials:"OC", flag:"🇦🇺", country:"Avustralya",  language:"İngilizce",
      phone:"+61 400 987 654", email:"olivia.carter@email.com",
      sourceId:"SRC-01", firstContact:"05 Haz 2026", lastContact:"Bugün",
      status:"Rezervasyonu Var", tags:[],
      notes:"Pickup bilgisi henüz gelmedi.",
    },
  ],

  leads: [
    {
      id:"LEAD-001", customerId:"CUST-001", sourceId:"SRC-06",
      tour:"Private Istanbul Experience", tourId:"TUR-001",
      dateRange:"22 Haz – 26 Haz 2026", travelStart:"2026-06-22", paxAdult:4, paxChild:0,
      status:"Teklif Gönderildi", assigneeId:"STAFF-001",
      budget:0, currency:"EUR", importType:"manuel",
      notes:"VIP misafir, özel rehber istiyor.", ago:"2 saat önce", createdAt:"2026-06-03",
    },
    {
      id:"LEAD-002", customerId:"CUST-006", sourceId:"SRC-01",
      tour:"Old City Highlights Tour", tourId:"TUR-003",
      dateRange:"18 Haz 2026", travelStart:"2026-06-18", paxAdult:2, paxChild:0,
      status:"Yeni", assigneeId:null,
      budget:0, currency:"EUR", importType:"manuel",
      notes:"", ago:"45 dakika önce", createdAt:"2026-06-03",
    },
    {
      id:"LEAD-003", customerId:"CUST-002", sourceId:"SRC-02",
      tour:"Bosphorus & Asian Side Tour", tourId:"TUR-002",
      dateRange:"20 Haz – 22 Haz 2026", travelStart:"2026-06-20", paxAdult:6, paxChild:0,
      status:"Ödeme Bekleniyor", assigneeId:"STAFF-001",
      budget:0, currency:"EUR", importType:"manuel",
      notes:"Kapora onayı bekleniyor.", ago:"3 saat önce", createdAt:"2026-06-01",
    },
    {
      id:"LEAD-004", customerId:"CUST-003", sourceId:"SRC-03",
      tour:"Özel Kapadokya Turu", tourId:"TUR-004",
      dateRange:"25 Haz – 28 Haz 2026", travelStart:"2026-06-25", paxAdult:3, paxChild:0,
      status:"Onaylandı", assigneeId:"STAFF-001",
      budget:0, currency:"TRY", importType:"manuel",
      notes:"Balayı çifti, sürpriz düzenlenebilir.", ago:"1 gün önce", createdAt:"2026-06-02",
    },
    {
      id:"LEAD-005", customerId:"CUST-007", sourceId:"SRC-04",
      tour:"Old City Highlights Tour", tourId:"TUR-003",
      dateRange:"30 Haz 2026", travelStart:"2026-06-30", paxAdult:2, paxChild:0,
      status:"Teklif Hazırlanıyor", assigneeId:"STAFF-001",
      budget:0, currency:"EUR", importType:"manuel",
      notes:"", ago:"5 saat önce", createdAt:"2026-06-03",
    },
    {
      id:"LEAD-006", customerId:"CUST-005", sourceId:"SRC-09",
      tour:"Private Istanbul Experience", tourId:"TUR-001",
      dateRange:"15 Tem – 19 Tem 2026", travelStart:"2026-07-15", paxAdult:4, paxChild:0,
      status:"Onaylandı", assigneeId:"STAFF-001",
      budget:0, currency:"EUR", importType:"manuel",
      notes:"Japonca rehber tercihi.", ago:"2 gün önce", createdAt:"2026-06-02",
    },
    {
      id:"LEAD-007", customerId:"CUST-008", sourceId:"SRC-01",
      tour:"Bosphorus & Asian Side Tour", tourId:"TUR-002",
      dateRange:"08 Tem 2026", travelStart:"2026-07-08", paxAdult:2, paxChild:0,
      status:"Teklif Gönderildi", assigneeId:"STAFF-001",
      budget:0, currency:"EUR", importType:"manuel",
      notes:"", ago:"6 saat önce", createdAt:"2026-06-05",
    },
  ],

  quotes: [
    {
      id:"Q-2026-001", leadId:"LEAD-001", customerId:"CUST-001", tourId:"TUR-001",
      tour:"Private Istanbul Experience", dateRange:"22 Haz – 26 Haz 2026",
      pax:4, unitPrice:90, total:3600, currency:"EUR",
      deposit:900, remaining:2700, discountPct:0,
      status:"Gönderildi", validUntil:"10 Haz 2026", createdAt:"04 Haz 2026",
      assigneeId:"STAFF-001", notes:"VIP misafir. Boğaz turu opsiyonu eklendi.",
    },
    {
      id:"Q-2026-002", leadId:"LEAD-003", customerId:"CUST-002", tourId:"TUR-002",
      tour:"Bosphorus & Asian Side Tour", dateRange:"20 Haz – 22 Haz 2026",
      pax:6, unitPrice:87, total:5200, currency:"EUR",
      deposit:5200, remaining:0, discountPct:0,
      status:"Onaylandı", validUntil:"15 Haz 2026", createdAt:"04 Haz 2026",
      assigneeId:"STAFF-001", notes:"Tam ödeme alındı.",
    },
    {
      id:"Q-2026-003", leadId:"LEAD-005", customerId:"CUST-007", tourId:"TUR-003",
      tour:"Old City Highlights Tour", dateRange:"30 Haz 2026",
      pax:2, unitPrice:120, total:240, currency:"EUR",
      deposit:60, remaining:180, discountPct:0,
      status:"Taslak", validUntil:"20 Haz 2026", createdAt:"05 Haz 2026",
      assigneeId:"STAFF-001", notes:"",
    },
    {
      id:"Q-2026-004", leadId:"LEAD-004", customerId:"CUST-003", tourId:"TUR-004",
      tour:"Cappadocia Full Experience", dateRange:"25 Haz – 28 Haz 2026",
      pax:3, unitPrice:380, total:1140, currency:"TRY",
      deposit:1140, remaining:0, discountPct:0,
      status:"Onaylandı", validUntil:"12 Haz 2026", createdAt:"02 Haz 2026",
      assigneeId:"STAFF-001", notes:"Balayı paketi.",
    },
    {
      id:"Q-2026-005", leadId:"LEAD-006", customerId:"CUST-005", tourId:"TUR-001",
      tour:"Private Istanbul Experience", dateRange:"15 Tem – 19 Tem 2026",
      pax:4, unitPrice:90, total:3600, currency:"EUR",
      deposit:900, remaining:2700, discountPct:0,
      status:"Onaylandı", validUntil:"01 Tem 2026", createdAt:"03 Haz 2026",
      assigneeId:"STAFF-001", notes:"",
    },
    {
      id:"Q-2026-006", leadId:"LEAD-007", customerId:"CUST-008", tourId:"TUR-002",
      tour:"Bosphorus & Asian Side Tour", dateRange:"08 Tem 2026",
      pax:2, unitPrice:100, total:200, currency:"EUR",
      deposit:50, remaining:150, discountPct:0,
      status:"Gönderildi", validUntil:"30 Haz 2026", createdAt:"05 Haz 2026",
      assigneeId:"STAFF-001", notes:"",
    },
    {
      id:"Q-2026-007", leadId:"LEAD-002", customerId:"CUST-006", tourId:"TUR-003",
      tour:"Old City Highlights Tour", dateRange:"18 Haz 2026",
      pax:2, unitPrice:90, total:180, currency:"EUR",
      deposit:0, remaining:180, discountPct:0,
      status:"Taslak", validUntil:"15 Haz 2026", createdAt:"03 Haz 2026",
      assigneeId:null, notes:"",
    },
  ],

  reservations: [
    {
      id:"R-2026-001", leadId:"LEAD-001", quoteId:"Q-2026-001", customerId:"CUST-001", tourId:"TUR-001",
      tour:"Private Istanbul Experience", date:"22 Haz 2026", time:"09:00", duration:"8 Saat",
      pax:4, guide:"Ahmet Yıldız", vehicle:"Mercedes Vito · 34 ABC 123", driver:"Mehmet Kaya",
      pickup:"The Marmara Pera, Lobby", pickupTime:"08:30",
      opStatus:"Rehber Atandı", payStatus:"Kapora Ödendi",
      total:3600, deposit:900, remaining:2700, currency:"EUR",
      opNotes:"VIP misafir. Boğaz turu seçeneği istedi. Vejetaryen öğle yemeği.",
      assigneeId:"STAFF-001", createdAt:"2026-06-03",
    },
    {
      id:"R-2026-002", leadId:"LEAD-003", quoteId:"Q-2026-002", customerId:"CUST-002", tourId:"TUR-002",
      tour:"Bosphorus & Asian Side Tour", date:"20 Haz 2026", time:"10:30", duration:"6 Saat",
      pax:6, guide:"Fatma Şahin", vehicle:"Ford Transit · 34 DEF 456", driver:"Ali Çelik",
      pickup:"Hilton Istanbul Bosphorus, Giriş", pickupTime:"10:00",
      opStatus:"Hazırlanıyor", payStatus:"Ödendi",
      total:5200, deposit:5200, remaining:0, currency:"EUR",
      opNotes:"Grup büyük, ekstra su ve ikram hazırlanacak.",
      assigneeId:"STAFF-001", createdAt:"2026-06-04",
    },
    {
      id:"R-2026-003", leadId:"LEAD-004", quoteId:"Q-2026-004", customerId:"CUST-003", tourId:"TUR-004",
      tour:"Özel Kapadokya Turu", date:"25 Haz 2026", time:"06:00", duration:"2 Gün",
      pax:3, guide:"Osman Aydın", vehicle:"Toyota HiAce · 06 GHI 789", driver:"Hasan Yılmaz",
      pickup:"İstanbul Havalimanı, Gidiş", pickupTime:"05:30",
      opStatus:"Hazır", payStatus:"Ödendi",
      total:18000, deposit:18000, remaining:0, currency:"TRY",
      opNotes:"Balayı çifti + 1 kişi. Sürpriz çiçek ve şampanya.",
      assigneeId:"STAFF-001", createdAt:"2026-06-02",
    },
    {
      id:"R-2026-004", leadId:"LEAD-006", quoteId:"Q-2026-005", customerId:"CUST-005", tourId:"TUR-001",
      tour:"Private Istanbul Experience", date:"15 Tem 2026", time:"09:30", duration:"8 Saat",
      pax:4, guide:"", vehicle:"", driver:"",
      pickup:"Four Seasons Sultanahmet, Lobby", pickupTime:"09:00",
      opStatus:"Hazırlanıyor", payStatus:"Kapora Ödendi",
      total:3600, deposit:900, remaining:2700, currency:"EUR",
      opNotes:"Henüz rehber atanmadı. Japonca konuşan rehber tercih ediliyor.",
      assigneeId:"STAFF-001", createdAt:"2026-06-02",
    },
    {
      id:"R-2026-005", leadId:"LEAD-007", quoteId:"Q-2026-006", customerId:"CUST-008", tourId:"TUR-002",
      tour:"Bosphorus & Asian Side Tour", date:"08 Tem 2026", time:"10:00", duration:"6 Saat",
      pax:2, guide:"", vehicle:"", driver:"",
      pickup:"Belirtilmedi", pickupTime:"—",
      opStatus:"Hazırlanıyor", payStatus:"Kapora Ödendi",
      total:2200, deposit:550, remaining:1650, currency:"EUR",
      opNotes:"",
      assigneeId:"STAFF-001", createdAt:"2026-06-05",
    },
  ],

  payments: [
    {
      id:"PAY-001", resId:"R-2026-001", customerId:"CUST-001", leadId:"LEAD-001",
      paymentType:"deposit", amount:900, currency:"EUR",
      status:"Kısmi Ödendi", method:"Banka Transferi",
      dueDate:"07 Haz 2026", dueDateRaw:4, depositDate:"04 Haz 2026",
      notes:"Kapora alındı. Kalan ödeme tur öncesi bekleniyor.",
      createdAt:"2026-06-03",
    },
    {
      id:"PAY-002", resId:"R-2026-002", customerId:"CUST-002", leadId:"LEAD-003",
      paymentType:"full", amount:5200, currency:"EUR",
      status:"Tamamlandı", method:"Kredi Kartı",
      dueDate:"15 Haz 2026", dueDateRaw:12, depositDate:"04 Haz 2026",
      notes:"Tam ödeme alındı.",
      createdAt:"2026-06-04",
    },
    {
      id:"PAY-003", resId:"R-2026-003", customerId:"CUST-003", leadId:"LEAD-004",
      paymentType:"full", amount:18000, currency:"TRY",
      status:"Tamamlandı", method:"Banka Transferi",
      dueDate:"20 Haz 2026", dueDateRaw:17, depositDate:"02 Haz 2026",
      notes:"Tam ödeme yapıldı. Balayı paketi.",
      createdAt:"2026-06-02",
    },
    {
      id:"PAY-004", resId:"R-2026-004", customerId:"CUST-005", leadId:"LEAD-006",
      paymentType:"deposit", amount:900, currency:"EUR",
      status:"Kısmi Ödendi", method:"Wise",
      dueDate:"10 Tem 2026", dueDateRaw:37, depositDate:"03 Haz 2026",
      notes:"Kapora alındı. Kalan bakiye tur haftasında.",
      createdAt:"2026-06-02",
    },
    {
      id:"PAY-005", resId:"R-2026-005", customerId:"CUST-008", leadId:"LEAD-007",
      paymentType:"deposit", amount:550, currency:"EUR",
      status:"Kısmi Ödendi", method:"Kredi Kartı",
      dueDate:"05 Tem 2026", dueDateRaw:32, depositDate:"05 Haz 2026",
      notes:"Kapora alındı. Kalan bakiye tur tarihinden 3 gün önce.",
      createdAt:"2026-06-05",
    },
    {
      id:"PAY-006", resId:null, customerId:"CUST-006", leadId:"LEAD-002",
      paymentType:"pending", amount:180, currency:"EUR",
      status:"Bekliyor", method:"—",
      dueDate:"08 Haz 2026", dueDateRaw:5, depositDate:"—",
      notes:"Teklif gönderildi. Ödeme henüz başlamadı.",
      createdAt:"2026-06-03",
    },
  ],

  tasks: [
    { id:"TASK-001", title:"Sarah Johnson için ödeme takibi yap",           customerId:"CUST-001", leadId:"LEAD-001", resId:"R-2026-001", category:"Ödeme",          priority:"Acil",   dueDateRaw:0,  status:"Açık",         assigneeId:"STAFF-001", notes:"€2.700 kalan ödeme." },
    { id:"TASK-002", title:"Emma Brown rezervasyonu için rehber ata",        customerId:"CUST-002", leadId:"LEAD-003", resId:"R-2026-002", category:"Rehber",         priority:"Yüksek", dueDateRaw:0,  status:"Devam Ediyor",  assigneeId:"STAFF-001", notes:"6 kişilik grup." },
    { id:"TASK-003", title:"Michael Green için teklif hazırla",              customerId:"CUST-006", leadId:"LEAD-002", resId:null,         category:"Teklif",         priority:"Orta",   dueDateRaw:1,  status:"Açık",         assigneeId:null,        notes:"Old City Tour, 2 kişi." },
    { id:"TASK-004", title:"Yuki Tanaka pickup bilgisini gönder",            customerId:"CUST-005", leadId:"LEAD-006", resId:"R-2026-004", category:"Pickup",         priority:"Yüksek", dueDateRaw:19, status:"Açık",         assigneeId:"STAFF-001", notes:"Pickup saati ve lokasyon gönderilmedi." },
    { id:"TASK-005", title:"Yuki Tanaka için Japonca rehber ara",            customerId:"CUST-005", leadId:"LEAD-006", resId:"R-2026-004", category:"Rehber",         priority:"Yüksek", dueDateRaw:-2, status:"Açık",         assigneeId:"STAFF-001", notes:"Japonca zorunlu değil ama tercih ediliyor." },
    { id:"TASK-006", title:"Luca Rossi rezervasyon onayını gönder",          customerId:"CUST-007", leadId:"LEAD-005", resId:null,         category:"Müşteri Takibi", priority:"Orta",   dueDateRaw:-1, status:"Tamamlandı",   assigneeId:"STAFF-001", notes:"Onay e-postası gönderildi." },
    { id:"TASK-007", title:"Hans Müller iptali için iade işlemini başlat",   customerId:null,       leadId:null,       resId:null,         category:"Ödeme",          priority:"Yüksek", dueDateRaw:2,  status:"Açık",         assigneeId:"STAFF-001", notes:"İade politikasına göre işlem yapılacak." },
    { id:"TASK-008", title:"Olivia Carter için pickup lokasyonu al",         customerId:"CUST-008", leadId:"LEAD-007", resId:"R-2026-005", category:"Pickup",         priority:"Orta",   dueDateRaw:3,  status:"Açık",         assigneeId:null,        notes:"Müşteri henüz otel bilgisini göndermedi." },
    { id:"TASK-009", title:"Ayşe Demir için sürpriz çiçek siparişi",        customerId:"CUST-003", leadId:"LEAD-004", resId:"R-2026-003", category:"Operasyon",      priority:"Düşük",  dueDateRaw:21, status:"Açık",         assigneeId:"STAFF-001", notes:"Balayı çifti için organizasyon." },
    { id:"TASK-010", title:"Emma Brown teklif takibi — geri dönüş iste",     customerId:"CUST-002", leadId:"LEAD-003", resId:null,         category:"Teklif",         priority:"Orta",   dueDateRaw:1,  status:"Devam Ediyor", assigneeId:"STAFF-001", notes:"Teklif gönderildi, geri dönüş bekleniyor." },
  ],

  reminders: [
    { id:"REM-001", title:"Sarah Johnson kapora ödemesi takibi",              customerId:"CUST-001", leadId:"LEAD-001", resId:"R-2026-001", type:"Ödeme Takibi",   priority:"Acil",   dueDate:"03 Haz 2026", dueDateRaw:0,  status:"Açık",      source:"manuel",   assigneeId:"STAFF-001", notes:"€2.700 kalan ödeme. Son tarih 7 Haziran." },
    { id:"REM-002", title:"Emma Brown rezervasyonu için rehber atanmalı",      customerId:"CUST-002", leadId:"LEAD-003", resId:"R-2026-002", type:"Rehber Atama",   priority:"Yüksek", dueDate:"03 Haz 2026", dueDateRaw:0,  status:"Açık",      source:"otomatik", assigneeId:"STAFF-001", notes:"20 Haziran turu için rehber atanmadı." },
    { id:"REM-003", title:"Michael Green için teklif takibi",                 customerId:"CUST-006", leadId:"LEAD-002", resId:null,         type:"Teklif Takibi",  priority:"Orta",   dueDate:"03 Haz 2026", dueDateRaw:0,  status:"Açık",      source:"manuel",   assigneeId:"STAFF-001", notes:"Teklif 2 gün önce gönderildi." },
    { id:"REM-004", title:"Yuki Tanaka pickup bilgisi eksik",                 customerId:"CUST-005", leadId:"LEAD-006", resId:"R-2026-004", type:"Pickup Bilgisi", priority:"Yüksek", dueDate:"04 Haz 2026", dueDateRaw:1,  status:"Açık",      source:"otomatik", assigneeId:"STAFF-001", notes:"15 Temmuz turu öncesi pickup alınmalı." },
    { id:"REM-005", title:"Yarın 3 tur var — operasyon kontrolü",             customerId:null,       leadId:null,       resId:null,         type:"Tur Hatırlatma", priority:"Yüksek", dueDate:"04 Haz 2026", dueDateRaw:1,  status:"Açık",      source:"otomatik", assigneeId:"STAFF-001", notes:"04 Haziran operasyon özeti." },
    { id:"REM-006", title:"Olivia Carter otel bilgisi bekleniyor",            customerId:"CUST-008", leadId:"LEAD-007", resId:"R-2026-005", type:"Pickup Bilgisi", priority:"Orta",   dueDate:"06 Haz 2026", dueDateRaw:3,  status:"Açık",      source:"manuel",   assigneeId:null,        notes:"Müşteri henüz konaklama bilgisini göndermedi." },
    { id:"REM-007", title:"Luca Rossi için yorum isteği gönder",              customerId:"CUST-007", leadId:"LEAD-005", resId:null,         type:"Müşteri Takibi", priority:"Düşük",  dueDate:"02 Haz 2026", dueDateRaw:-1, status:"Tamamlandı",source:"manuel",   assigneeId:"STAFF-001", notes:"Google ve TripAdvisor yorum isteği gönderildi." },
    { id:"REM-008", title:"Sarah Johnson tur öncesi WhatsApp mesajı",         customerId:"CUST-001", leadId:"LEAD-001", resId:"R-2026-001", type:"Tur Hatırlatma", priority:"Orta",   dueDate:"21 Haz 2026", dueDateRaw:18, status:"Açık",      source:"otomatik", assigneeId:"STAFF-001", notes:"22 Haziran turundan 24 saat önce gönderilecek." },
    { id:"REM-009", title:"Ayşe Demir sürpriz organizasyon hazırlığı",        customerId:"CUST-003", leadId:"LEAD-004", resId:"R-2026-003", type:"Operasyon Notu", priority:"Orta",   dueDate:"24 Haz 2026", dueDateRaw:21, status:"Ertelendi", source:"manuel",   assigneeId:"STAFF-001", notes:"Tur tarihinden 1 gün önce çiçek siparişi." },
  ],

  activityLogs: [
    { id:"LOG-001", entityType:"lead",        entityId:"LEAD-001", action:"created",       description:"Talep oluşturuldu",         performedBy:"STAFF-001", createdAt:"2026-06-03T09:14:00" },
    { id:"LOG-002", entityType:"lead",        entityId:"LEAD-001", action:"call",          description:"Telefon görüşmesi yapıldı", performedBy:"STAFF-001", createdAt:"2026-06-03T14:32:00" },
    { id:"LOG-003", entityType:"quote",       entityId:"Q-2026-001",action:"sent",         description:"Teklif gönderildi",         performedBy:"STAFF-001", createdAt:"2026-06-04T11:05:00" },
    { id:"LOG-004", entityType:"lead",        entityId:"LEAD-001", action:"reply",         description:"Müşteri geri döndü",        performedBy:"CUST-001",  createdAt:"2026-06-05T16:48:00" },
    { id:"LOG-005", entityType:"lead",        entityId:"LEAD-003", action:"created",       description:"Talep oluşturuldu",         performedBy:"STAFF-001", createdAt:"2026-06-01T09:33:00" },
    { id:"LOG-006", entityType:"quote",       entityId:"Q-2026-002",action:"sent",         description:"Teklif gönderildi",         performedBy:"STAFF-001", createdAt:"2026-06-02T11:15:00" },
    { id:"LOG-007", entityType:"payment",     entityId:"PAY-002",  action:"payment",       description:"Ödeme alındı",              performedBy:"STAFF-001", createdAt:"2026-06-03T16:20:00" },
    { id:"LOG-008", entityType:"reservation", entityId:"R-2026-002",action:"created",      description:"Rezervasyon oluşturuldu",   performedBy:"STAFF-001", createdAt:"2026-06-03T16:25:00" },
    { id:"LOG-009", entityType:"lead",        entityId:"LEAD-004", action:"created",       description:"Talep oluşturuldu",         performedBy:"STAFF-001", createdAt:"2026-06-02T11:00:00" },
    { id:"LOG-010", entityType:"quote",       entityId:"Q-2026-004",action:"approved",     description:"Teklif onaylandı",          performedBy:"STAFF-001", createdAt:"2026-06-02T14:30:00" },
    { id:"LOG-011", entityType:"payment",     entityId:"PAY-003",  action:"payment",       description:"Ödeme alındı",              performedBy:"STAFF-001", createdAt:"2026-06-02T17:00:00" },
    { id:"LOG-012", entityType:"reservation", entityId:"R-2026-003",action:"created",      description:"Rezervasyon oluşturuldu",   performedBy:"STAFF-001", createdAt:"2026-06-02T17:05:00" },
    { id:"LOG-013", entityType:"lead",        entityId:"LEAD-002", action:"created",       description:"Talep oluşturuldu",         performedBy:"STAFF-001", createdAt:"2026-06-03T09:00:00" },
    { id:"LOG-014", entityType:"lead",        entityId:"LEAD-006", action:"created",       description:"Talep oluşturuldu",         performedBy:"STAFF-001", createdAt:"2026-06-02T09:00:00" },
    { id:"LOG-015", entityType:"payment",     entityId:"PAY-004",  action:"deposit",       description:"Kapora alındı",             performedBy:"STAFF-001", createdAt:"2026-06-03T14:00:00" },
    { id:"LOG-016", entityType:"reservation", entityId:"R-2026-004",action:"created",      description:"Rezervasyon oluşturuldu",   performedBy:"STAFF-001", createdAt:"2026-06-03T14:10:00" },
  ],
};

const getCustomerById       = (id) => DB.customers.find(c => c.id === id) || null;
const getLeadById           = (id) => DB.leads.find(l => l.id === id) || null;
const getQuoteById          = (id) => DB.quotes.find(q => q.id === id) || null;
const getReservationById    = (id) => DB.reservations.find(r => r.id === id) || null;
const getTourById           = (id) => DB.tours.find(t => t.id === id) || null;
const getPaymentsByResId    = (resId) => DB.payments.filter(p => p.resId === resId);
const getLeadsByCustomerId  = (custId) => DB.leads.filter(l => l.customerId === custId);
const getQuotesByCustomerId = (custId) => DB.quotes.filter(q => q.customerId === custId);
const getResByCustomerId    = (custId) => DB.reservations.filter(r => r.customerId === custId);
const getTasksByCustomerId  = (custId) => DB.tasks.filter(t => t.customerId === custId);
const enrichCustomer = (custId) => {
  const profile = CustomerService.getProfile(custId);
  if (profile) return profile;
  const c = getCustomerById(custId);
  if (!c) return null;
  const leads = getLeadsByCustomerId(custId);
  const quotes = getQuotesByCustomerId(custId);
  const reservations = getResByCustomerId(custId);
  const tasks = getTasksByCustomerId(custId);
  const totalSpend = DB.payments
    .filter(p => p.customerId === custId && ["Tamamlandı","Kısmi Ödendi"].includes(p.status))
    .reduce((s, p) => s + p.amount, 0);
  const currency = DB.payments.find(p=>p.customerId===custId)?.currency || "EUR";
  return {
    ...c,
    leads: leads.length,
    quotes: quotes.length,
    reservations: reservations.length,
    openTasks: tasks.filter(t=>t.status!=="Tamamlandı").length,
    totalSpend, currency,
    relatedLeads: leads.map(l => ({
      date: l.createdAt, source: DB.sources.find(s=>s.id===l.sourceId)?.label || l.sourceId,
      tour: l.tour, status: l.status, id: l.id,
    })),
    relatedQuotes: quotes.map(q => ({
      id: q.id, tour: q.tour,
      amount: `${q.currency==="TRY"?"₺":"€"}${q.total.toLocaleString("tr-TR")}`,
      status: q.status, date: q.createdAt,
    })),
    relatedReservations: reservations.map(r => ({
      id: r.id, tour: r.tour, date: r.date,
      pax: r.pax, opStatus: r.opStatus, payStatus: r.payStatus,
    })),
    timeline: getActivityLogs({customerId: custId}).map(log => {
      const typeMap = {
        lead: "lead", quote: "quote", payment: "payment",
        reservation: "reservation", call: "call", reply: "reply",
      };
      const staff = DB.staff.find(s=>s.id===log.performedBy);
      const dateStr = log.createdAt.split("T")[0].replace(/\d{4}-(\d{2})-(\d{2})/, (_,m,d)=>`${d} ${["Oca","Şub","Mar","Nis","May","Haz","Tem","Ağu","Eyl","Eki","Kas","Ara"][parseInt(m)-1]}`);
      const timeStr = log.createdAt.includes("T") ? log.createdAt.split("T")[1].slice(0,5) : "09:00";
      return {
        date: dateStr, type: typeMap[log.entityType] || "lead",
        action: log.action === "created" ? "Talep oluşturuldu"
          : log.action === "sent" ? "Teklif gönderildi"
          : log.action === "approved" ? "Teklif onaylandı"
          : log.action === "payment" || log.action === "deposit" ? "Ödeme alındı"
          : log.action === "call" ? "Telefon görüşmesi yapıldı"
          : log.action === "reply" ? "Müşteri geri döndü"
          : "Rezervasyon oluşturuldu",
        detail: log.description, who: staff?.name || log.performedBy, time: timeStr,
      };
    }),
  };
};

const getActivityLogs       = ({entityType, entityId, customerId} = {}) => {
  return DB.activityLogs.filter(l => {
    if (entityType && entityId) return l.entityType === entityType && l.entityId === entityId;
    if (customerId) {
      const custLeads = DB.leads.filter(ld=>ld.customerId===customerId).map(ld=>ld.id);
      const custQuotes = DB.quotes.filter(q=>q.customerId===customerId).map(q=>q.id);
      const custRes = DB.reservations.filter(r=>r.customerId===customerId).map(r=>r.id);
      return (
        (l.entityType==="lead"        && custLeads.includes(l.entityId)) ||
        (l.entityType==="quote"       && custQuotes.includes(l.entityId)) ||
        (l.entityType==="reservation" && custRes.includes(l.entityId)) ||
        (l.entityType==="payment"     && DB.payments.filter(p=>p.customerId===customerId).map(p=>p.id).includes(l.entityId))
      );
    }
    return true;
  });
};

const SESSION = {
  _prefill: null,
  setPrefill(data) { this._prefill = data; },
  getPrefill()     { const d = this._prefill; this._prefill = null; return d; },
};

const NAV_REF   = { fn: null };
const TOAST_REF = { show: null };
function showToast(msg) { try { if (TOAST_REF.show) TOAST_REF.show(msg); else console.info("[Toast]", msg); } catch(e) { console.info("[Toast]", msg); } }

function IDLink({ id, type }) {
  if (!id) return <span style={{color:C.textFaint, fontFamily:"'DM Mono',monospace", fontSize:12}}>—</span>;
  const routes = {
    lead:        '/leads/',
    quote:       '/quotes/',
    reservation: '/reservations/',
    customer:    '/customers/',
    tour:        '/tours/',
    payment:     '/payments',
  };
  const route = routes[type];
  const href = route ? '#' + route + (type === 'payment' ? '' : id) : null;
  if (!href) return <span style={{fontFamily:"'DM Mono',monospace", fontSize:12, color:C.textMid}}>{id}</span>;
  return (
    <a href={href} style={{
      fontFamily:"'DM Mono',monospace", fontSize:12, fontWeight:600,
      color:C.blue, textDecoration:"none",
      background:C.blueBg, padding:"2px 7px", borderRadius:4,
      border:`1px solid ${C.blue}22`,
      cursor:"pointer", display:"inline-block",
      transition:"background .1s, border-color .1s",
    }}
      onMouseEnter={e=>{ e.currentTarget.style.background=`${C.blue}22`; e.currentTarget.style.borderColor=C.blue; }}
      onMouseLeave={e=>{ e.currentTarget.style.background=C.blueBg; e.currentTarget.style.borderColor=`${C.blue}22`; }}
    >{id} →</a>
  );
}

const _TODAY_STR = new Date().toLocaleDateString("tr-TR",{day:"2-digit",month:"short",year:"numeric"});
const _TODAY_ISO = new Date().toISOString().split("T")[0];

function filterByDateRange(items, dateField, period) {
  const now=new Date(), todayISO=_TODAY_ISO;
  const dow=now.getDay()===0?6:now.getDay()-1;
  const wk=new Date(now); wk.setDate(now.getDate()-dow); wk.setHours(0,0,0,0);
  const wkISO=wk.toISOString().split("T")[0];
  const moISO=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`;
  const q3=new Date(now); q3.setMonth(q3.getMonth()-3); q3.setDate(1);
  const q3ISO=q3.toISOString().split("T")[0];
  return items.filter(item=>{
    let raw=item[dateField]||item.createdAt||item.date||"";
    let iso=raw;
    if(raw&&raw.match(/^\d{2}\s+\w+\s+\d{4}$/)){
      try{iso=new Date(raw.split(" ").reverse().join(" ")).toISOString().split("T")[0];}
      catch(_){iso="";}
    }
    if(!iso)return false;
    switch(period){
      case "Bugün":    return iso===todayISO;
      case "Bu Hafta": return iso>=wkISO&&iso<=todayISO;
      case "Bu Ay":    return iso>=moISO&&iso<=todayISO;
      case "Son 3 Ay": return iso>=q3ISO&&iso<=todayISO;
      default:         return true;
    }
  });
}

function computeUrgent(leads, reservations, payments, tasks, reminders) {
  // Supabase mode: `null` means "not loaded yet" — must resolve to an empty
  // list, never to the DB mock arrays. Falling back to DB.* here previously
  // made "Acil İşler" flash fabricated urgent items on every dashboard load,
  // which then vanished once the real (usually shorter/empty) data arrived.
  const useMock = !AppConfig.useSupabase;
  const items=[];let id=1;const now=Date.now();
  (payments ?? (useMock ? DB.payments : [])).filter(p=>["Bekliyor","Kısmi Ödendi"].includes(p.status)).slice(0,3).forEach(p=>{
    const res=getReservationById(p.resId||""),cust=getCustomerById(res?.customerId||"");
    items.push({id:id++,level:"high",title:`${cust?.name||"Müşteri"} için ödeme takibi`,
      sub:`${res?.tour||"Rezervasyon"} · €${parseFloat(p.amount||0).toLocaleString("tr-TR")} bekliyor`,
      tag:"Ödeme",tagColor:C.red,tagBg:C.redBg,ago:p.depositDate||"—",
      icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20"});
  });
  (reservations ?? (useMock ? DB.reservations : [])).filter(r=>!r.guide&&!["Tamamlandı","İptal"].includes(r.opStatus)).slice(0,2).forEach(r=>{
    const cust=getCustomerById(r.customerId||"");
    items.push({id:id++,level:"high",title:`${cust?.name||"Rezervasyon"} için rehber atanmalı`,
      sub:`${r.tour||"Tur"} · ${r.date||"—"} · ${r.pax||1} kişi`,
      tag:"Rehber",tagColor:C.blue,tagBg:C.blueBg,ago:r.date||"—",
      icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75"});
  });
  (tasks ?? (useMock ? DB.tasks : [])).filter(t=>t.status!=="Tamamlandı"&&["Yüksek","Acil"].includes(t.priority)).slice(0,2).forEach(t=>{
    items.push({id:id++,level:"medium",title:t.title,sub:`Öncelik: ${t.priority} · ${t.dueDate||"—"}`,
      tag:"Görev",tagColor:C.amber,tagBg:"#FEF3E2",ago:t.dueDate||"—",
      icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"});
  });
  (reminders ?? (useMock ? DB.reminders : [])).filter(r=>!r.status?.includes("Tamamlandı")&&r.dueDateRaw&&r.dueDateRaw<now).slice(0,2).forEach(r=>{
    items.push({id:id++,level:"medium",title:r.title,sub:`Gecikmiş · ${r.type||"Hatırlatma"}`,
      tag:"Hatırlatma",tagColor:"#6B3FA0",tagBg:"#F3EEF9",ago:r.dueDate||"—",
      icon:"M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"});
  });
  return items.slice(0,5);
}

const METRICS = {
  get newLeads()            { return DB.leads.filter(l=>l.status==="Yeni").length; },
  get openLeads()           { return DB.leads.filter(l=>!["Onaylandı","İptal"].includes(l.status)).length; },
  get todayTourCount()      { return DB.reservations.filter(r=>r.date===_TODAY_STR||r.checkIn===_TODAY_ISO).length; },
  get todayTours()          { return DB.reservations.filter(r=>r.date===_TODAY_STR||r.checkIn===_TODAY_ISO); },
  get upcomingReservations(){ return DB.reservations.filter(r=>!["Tamamlandı","İptal"].includes(r.opStatus)); },
  get pendingPaymentsCount(){ return DB.payments.filter(p=>["Bekliyor","Kısmi Ödendi"].includes(p.status)).length; },
  get pendingPaymentsEUR()  {
    return DB.payments.filter(p=>p.currency==="EUR"&&["Bekliyor","Kısmi Ödendi"].includes(p.status))
      .reduce((s,p)=> s + (p.resId ? (getReservationById(p.resId)||{remaining:0}).remaining : p.amount), 0);
  },
  get expectedRevenueEUR()  { return DB.payments.filter(p=>p.currency==="EUR").reduce((s,p)=>s+(getReservationById(p.resId||"")||{total:p.amount}).total,0); },
  get collectedEUR()        { return DB.payments.filter(p=>p.currency==="EUR"&&p.status!=="Bekliyor").reduce((s,p)=>s+p.amount,0); },
  get noGuideCount()        { return DB.reservations.filter(r=>!r.guide&&!["Tamamlandı","İptal"].includes(r.opStatus)).length; },
  get activeTasksToday()    { return DB.tasks.filter(t=>t.dueDateRaw===0&&t.status!=="Tamamlandı").length; },
};

const Store = (() => {
  const listeners = new Set();
  return {
    subscribe(fn)   { listeners.add(fn); return () => listeners.delete(fn); },
    notify()        { listeners.forEach(fn => fn()); },
  };
})();

function useStore() {
  const [tick, setTick] = useState(0);
  useEffect(() => Store.subscribe(() => setTick(t => t + 1)), []);
  return tick;
}

const CustomerRepository = {
  getAll(filters = {}) {
    let items = DB.customers;
    if (filters.status)   items = items.filter(c => c.status === filters.status);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.includes(q) ||
        c.country?.toLowerCase().includes(q)
      );
    }
    return items;
  },
  getById(id) {
    return DB.customers.find(c => c.id === id) || null;
  },
  create(data) {
    const id = 'CUST-' + String(DB.customers.length + 1).padStart(3, '0');
    const record = {
      id,
      status: 'Aktif',
      tags: ['Yeni'],
      firstContact: new Date().toLocaleDateString('tr-TR', { day:'2-digit', month:'short', year:'numeric' }),
      lastContact: 'Bugün',
      ...data,
    };
    DB.customers.push(record);
    ActivityRepository.create({
      entityType: 'customer', entityId: id,
      action: 'created', description: `Yeni misafir oluşturuldu: ${record.name}`,
    });
    Store.notify();
    return record;
  },
  update(id, patch) {
    const idx = DB.customers.findIndex(c => c.id === id);
    if (idx < 0) return null;
    Object.assign(DB.customers[idx], patch);
    Store.notify();
    return DB.customers[idx];
  },
  delete(id) {
    const idx = DB.customers.findIndex(c => c.id === id);
    if (idx < 0) return false;
    DB.customers.splice(idx, 1);
    Store.notify();
    return true;
  },
  findByContact({ email, phone }) {
    return DB.customers.find(c =>
      (email && c.email === email) || (phone && c.phone === phone)
    ) || null;
  },
};

const LeadRepository = {
  getAll(filters = {}) {
    let items = DB.leads;
    if (filters.status)     items = items.filter(l => l.status === filters.status);
    if (filters.customerId) items = items.filter(l => l.customerId === filters.customerId);
    if (filters.assigneeId) items = items.filter(l => l.assigneeId === filters.assigneeId);
    if (filters.sourceId)   items = items.filter(l => l.sourceId === filters.sourceId);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter(l =>
        l.tour?.toLowerCase().includes(q) ||
        l.id.toLowerCase().includes(q) ||
        getCustomerById(l.customerId)?.name?.toLowerCase().includes(q)
      );
    }
    return items;
  },
  getById(id) {
    return DB.leads.find(l => l.id === id) || null;
  },
  getByCustomerId(customerId) {
    return DB.leads.filter(l => l.customerId === customerId);
  },
  create(data) {
    const id = 'LEAD-' + String(DB.leads.length + 1).padStart(3, '0');
    const record = {
      id,
      status: 'Yeni',
      currency: 'EUR',
      importType: 'manuel',
      ago: 'Az önce',
      createdAt: new Date().toISOString().split('T')[0],
      ...data,
    };
    DB.leads.push(record);
    ActivityRepository.create({
      entityType: 'lead', entityId: id,
      action: 'created', description: `Yeni talep oluşturuldu: ${record.tour || id}`,
    });
    Store.notify();
    return record;
  },
  update(id, patch) {
    const idx = DB.leads.findIndex(l => l.id === id);
    if (idx < 0) return null;
    Object.assign(DB.leads[idx], patch);
    ActivityRepository.create({
      entityType: 'lead', entityId: id,
      action: 'updated', description: `Talep güncellendi: ${Object.keys(patch).join(', ')}`,
    });
    Store.notify();
    return DB.leads[idx];
  },
  delete(id) {
    const idx = DB.leads.findIndex(l => l.id === id);
    if (idx < 0) return false;
    DB.leads.splice(idx, 1);
    Store.notify();
    return true;
  },
};

const QuoteRepository = {
  getAll(filters = {}) {
    let items = DB.quotes;
    if (filters.status)     items = items.filter(q => q.status === filters.status);
    if (filters.customerId) items = items.filter(q => q.customerId === filters.customerId);
    if (filters.leadId)     items = items.filter(q => q.leadId === filters.leadId);
    return items;
  },
  getById(id) {
    return DB.quotes.find(q => q.id === id) || null;
  },
  getByCustomerId(customerId) {
    return DB.quotes.filter(q => q.customerId === customerId);
  },
  create(data) {
    const id = 'Q-' + new Date().getFullYear() + '-' + String(DB.quotes.length + 1).padStart(3, '0');
    const record = {
      id,
      status: 'Taslak',
      createdAt: new Date().toLocaleDateString('tr-TR', { day:'2-digit', month:'short', year:'numeric' }),
      assigneeId: 'STAFF-001',
      ...data,
    };
    DB.quotes.push(record);
    ActivityRepository.create({
      entityType: 'quote', entityId: id,
      action: 'created', description: `Teklif oluşturuldu: ${record.tour || id}`,
    });
    Store.notify();
    return record;
  },
  update(id, patch) {
    const idx = DB.quotes.findIndex(q => q.id === id);
    if (idx < 0) return null;
    Object.assign(DB.quotes[idx], patch);
    ActivityRepository.create({
      entityType: 'quote', entityId: id,
      action: 'updated', description: `Teklif güncellendi → ${patch.status || 'güncellendi'}`,
    });
    Store.notify();
    return DB.quotes[idx];
  },
  delete(id) {
    const idx = DB.quotes.findIndex(q => q.id === id);
    if (idx < 0) return false;
    DB.quotes.splice(idx, 1);
    Store.notify();
    return true;
  },
};

const ReservationRepository = {
  getAll(filters = {}) {
    let items = DB.reservations;
    if (filters.opStatus)   items = items.filter(r => r.opStatus === filters.opStatus);
    if (filters.payStatus)  items = items.filter(r => r.payStatus === filters.payStatus);
    if (filters.customerId) items = items.filter(r => r.customerId === filters.customerId);
    if (filters.tourId)     items = items.filter(r => r.tourId === filters.tourId);
    if (filters.noGuide)    items = items.filter(r => !r.guide && !['Tamamlandı','İptal'].includes(r.opStatus));
    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter(r =>
        r.id.toLowerCase().includes(q) ||
        r.tour?.toLowerCase().includes(q) ||
        getCustomerById(r.customerId)?.name?.toLowerCase().includes(q)
      );
    }
    return items;
  },
  getById(id) {
    return DB.reservations.find(r => r.id === id) || null;
  },
  getByCustomerId(customerId) {
    return DB.reservations.filter(r => r.customerId === customerId);
  },
  create(data) {
    const id = 'R-' + new Date().getFullYear() + '-' + String(DB.reservations.length + 1).padStart(3, '0');
    const record = {
      id,
      opStatus: 'Hazırlanıyor',
      payStatus: 'Bekliyor',
      guide: '', vehicle: '', driver: '',
      createdAt: new Date().toISOString().split('T')[0],
      assigneeId: 'STAFF-001',
      ...data,
    };
    DB.reservations.push(record);
    ActivityRepository.create({
      entityType: 'reservation', entityId: id,
      action: 'created', description: `Rezervasyon oluşturuldu: ${record.tour || id}`,
    });
    Store.notify();
    return record;
  },
  update(id, patch) {
    const idx = DB.reservations.findIndex(r => r.id === id);
    if (idx < 0) return null;
    Object.assign(DB.reservations[idx], patch);
    ActivityRepository.create({
      entityType: 'reservation', entityId: id,
      action: 'updated', description: `Rezervasyon güncellendi: ${Object.keys(patch).join(', ')}`,
    });
    Store.notify();
    return DB.reservations[idx];
  },
  delete(id) {
    const idx = DB.reservations.findIndex(r => r.id === id);
    if (idx < 0) return false;
    DB.reservations.splice(idx, 1);
    Store.notify();
    return true;
  },
};

const PaymentRepository = {
  getAll(filters = {}) {
    let items = DB.payments;
    if (filters.status)     items = items.filter(p => p.status === filters.status);
    if (filters.customerId) items = items.filter(p => p.customerId === filters.customerId);
    if (filters.resId)      items = items.filter(p => p.resId === filters.resId);
    if (filters.currency)   items = items.filter(p => p.currency === filters.currency);
    return items;
  },
  getById(id) {
    return DB.payments.find(p => p.id === id) || null;
  },
  getByResId(resId) {
    return DB.payments.filter(p => p.resId === resId);
  },
  create(data) {
    const id = 'PAY-' + String(DB.payments.length + 1).padStart(3, '0');
    const today = new Date().toLocaleDateString('tr-TR', { day:'2-digit', month:'short', year:'numeric' });
    const record = {
      id,
      status: 'Bekliyor',
      depositDate: today,
      dueDate: today,
      dueDateRaw: 0,
      createdAt: new Date().toISOString().split('T')[0],
      ...data,
    };
    DB.payments.push(record);
    if (record.resId) {
      const res = ReservationRepository.getById(record.resId);
      if (res) {
        const amt = record.amount || 0;
        if (record.paymentType === 'full' || data.payType === 'Tam Ödeme') {
          res.payStatus = 'Ödendi'; res.remaining = 0;
        } else if (record.paymentType === 'deposit' || data.payType === 'Kapora') {
          res.payStatus = 'Kapora Ödendi';
          res.deposit = (res.deposit || 0) + amt;
          res.remaining = Math.max(0, (res.remaining || 0) - amt);
        }
      }
    }
    ActivityRepository.create({
      entityType: 'payment', entityId: id,
      action: 'payment',
      description: `Ödeme kaydedildi: ${record.currency === 'TRY' ? '₺' : '€'}${record.amount?.toLocaleString('tr-TR') || 0}`,
    });
    Store.notify();
    return record;
  },
  update(id, patch) {
    const idx = DB.payments.findIndex(p => p.id === id);
    if (idx < 0) return null;
    Object.assign(DB.payments[idx], patch);
    Store.notify();
    return DB.payments[idx];
  },
  delete(id) {
    const idx = DB.payments.findIndex(p => p.id === id);
    if (idx < 0) return false;
    DB.payments.splice(idx, 1);
    Store.notify();
    return true;
  },
};

const TaskRepository = {
  getAll(filters = {}) {
    let items = DB.tasks;
    if (filters.status)     items = items.filter(t => t.status === filters.status);
    if (filters.priority)   items = items.filter(t => t.priority === filters.priority);
    if (filters.customerId) items = items.filter(t => t.customerId === filters.customerId);
    if (filters.assigneeId) items = items.filter(t => t.assigneeId === filters.assigneeId);
    return items;
  },
  getById(id) {
    return DB.tasks.find(t => t.id === id) || null;
  },
  create(data) {
    const id = 'TASK-' + String(DB.tasks.length + 1).padStart(3, '0');
    const record = { id, status: 'Açık', dueDateRaw: 0, ...data };
    DB.tasks.push(record);
    Store.notify();
    return record;
  },
  update(id, patch) {
    const idx = DB.tasks.findIndex(t => t.id === id);
    if (idx < 0) return null;
    Object.assign(DB.tasks[idx], patch);
    Store.notify();
    return DB.tasks[idx];
  },
  toggle(id) {
    const t = DB.tasks.find(x => x.id === id);
    if (!t) return null;
    t.status = t.status === 'Tamamlandı' ? 'Açık' : 'Tamamlandı';
    Store.notify();
    return t;
  },
  delete(id) {
    const idx = DB.tasks.findIndex(t => t.id === id);
    if (idx < 0) return false;
    DB.tasks.splice(idx, 1);
    Store.notify();
    return true;
  },
};

const ReminderRepository = {
  getAll(filters = {}) {
    let items = DB.reminders;
    if (filters.status)     items = items.filter(r => r.status === filters.status);
    if (filters.type)       items = items.filter(r => r.type === filters.type);
    if (filters.customerId) items = items.filter(r => r.customerId === filters.customerId);
    return items;
  },
  getById(id) {
    return DB.reminders.find(r => r.id === id) || null;
  },
  create(data) {
    const id = 'REM-' + String(DB.reminders.length + 1).padStart(3, '0');
    const record = { id, status: 'Açık', source: 'manuel', dueDateRaw: 0, ...data };
    DB.reminders.push(record);
    Store.notify();
    return record;
  },
  update(id, patch) {
    const idx = DB.reminders.findIndex(r => r.id === id);
    if (idx < 0) return null;
    Object.assign(DB.reminders[idx], patch);
    Store.notify();
    return DB.reminders[idx];
  },
  toggle(id) {
    const r = DB.reminders.find(x => x.id === id);
    if (!r) return null;
    r.status = r.status === 'Tamamlandı' ? 'Açık' : 'Tamamlandı';
    Store.notify();
    return r;
  },
  delete(id) {
    const idx = DB.reminders.findIndex(r => r.id === id);
    if (idx < 0) return false;
    DB.reminders.splice(idx, 1);
    Store.notify();
    return true;
  },
};

const TourRepository = {
  getAll(filters = {}) {
    let items = DB.tours;
    if (filters.status)   items = items.filter(t => t.status === filters.status);
    if (filters.category) items = items.filter(t => t.category === filters.category);
    if (filters.active)   items = items.filter(t => t.status === 'Aktif');
    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.category?.toLowerCase().includes(q)
      );
    }
    return items;
  },
  getById(id) {
    return DB.tours.find(t => t.id === id) || null;
  },
  create(data) {
    const id = 'TUR-' + String(DB.tours.length + 1).padStart(3, '0');
    const record = {
      id,
      status: 'Aktif',
      usageCount: 0,
      updatedAt: new Date().toLocaleDateString('tr-TR', { day:'2-digit', month:'short', year:'numeric' }),
      included: [], excluded: [],
      ops: { pickup:true, vehicle:true, guide:true, defaultNotes:'' },
      ...data,
    };
    DB.tours.push(record);
    Store.notify();
    return record;
  },
  update(id, patch) {
    const idx = DB.tours.findIndex(t => t.id === id);
    if (idx < 0) return null;
    patch.updatedAt = new Date().toLocaleDateString('tr-TR', { day:'2-digit', month:'short', year:'numeric' });
    Object.assign(DB.tours[idx], patch);
    Store.notify();
    return DB.tours[idx];
  },
  delete(id) {
    const idx = DB.tours.findIndex(t => t.id === id);
    if (idx < 0) return false;
    DB.tours.splice(idx, 1);
    Store.notify();
    return true;
  },
};

const ActivityRepository = {
  getAll(filters = {}) {
    let items = DB.activityLogs;
    if (filters.entityType) items = items.filter(l => l.entityType === filters.entityType);
    if (filters.entityId)   items = items.filter(l => l.entityId === filters.entityId);
    if (filters.customerId) {
      const custLeads  = DB.leads.filter(l => l.customerId === filters.customerId).map(l => l.id);
      const custQuotes = DB.quotes.filter(q => q.customerId === filters.customerId).map(q => q.id);
      const custRes    = DB.reservations.filter(r => r.customerId === filters.customerId).map(r => r.id);
      const custPays   = DB.payments.filter(p => p.customerId === filters.customerId).map(p => p.id);
      items = items.filter(l =>
        (l.entityType === 'lead'        && custLeads.includes(l.entityId))  ||
        (l.entityType === 'quote'       && custQuotes.includes(l.entityId)) ||
        (l.entityType === 'reservation' && custRes.includes(l.entityId))    ||
        (l.entityType === 'payment'     && custPays.includes(l.entityId))   ||
        (l.entityType === 'customer'    && l.entityId === filters.customerId)
      );
    }
    return items.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  create(data) {
    const id = 'LOG-' + String(DB.activityLogs.length + 1).padStart(3, '0');
    const record = {
      id,
      performedBy: 'STAFF-001',
      createdAt: new Date().toISOString(),
      ...data,
    };
    DB.activityLogs.push(record);
    return record;
  },
};

const MessageRepository = {
  getAll(filters = {}) {
    let items = typeof MOCK_CONVERSATIONS !== 'undefined' ? MOCK_CONVERSATIONS : [];
    if (filters.channel)  items = items.filter(c => c.channel === filters.channel);
    if (filters.unread)   items = items.filter(c => c.unread > 0);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter(c => {
        const cust = CustomerRepository.getById(c.customerId);
        return cust?.name?.toLowerCase().includes(q) || c.subject?.toLowerCase().includes(q);
      });
    }
    return items;
  },
  getById(id) {
    const convs = typeof MOCK_CONVERSATIONS !== 'undefined' ? MOCK_CONVERSATIONS : [];
    return convs.find(c => c.id === id) || null;
  },
  markRead(id) {
    const conv = this.getById(id);
    if (conv) { conv.unread = 0; Store.notify(); }
  },
  getTotalUnread() {
    const convs = typeof MOCK_CONVERSATIONS !== 'undefined' ? MOCK_CONVERSATIONS : [];
    return convs.reduce((s, c) => s + (c.unread || 0), 0);
  },
};

const LeadService = {

  createWithCustomer({ customerData, leadData }) {
    let customer = CustomerRepository.findByContact({
      email: customerData.email,
      phone: customerData.phone,
    });
    let isNewCustomer = false;
    if (!customer) {
      customer = CustomerRepository.create(customerData);
      isNewCustomer = true;
    }
    const lead = LeadRepository.create({
      ...leadData,
      customerId: customer.id,
    });
    return { lead, customer, isNewCustomer };
  },

  advance(leadId) {
    const FLOW = ['Yeni', 'Görüşüldü', 'Teklif Hazırlanıyor', 'Teklif Gönderildi', 'Ödeme Bekleniyor', 'Onaylandı'];
    const lead = LeadRepository.getById(leadId);
    if (!lead) return null;
    const idx = FLOW.indexOf(lead.status);
    if (idx < FLOW.length - 1) {
      return LeadRepository.update(leadId, { status: FLOW[idx + 1] });
    }
    return lead;
  },
};

const QuoteService = {

  convertToReservation(quoteId) {
    const quote = QuoteRepository.getById(quoteId);
    if (!quote) throw new Error('Teklif bulunamadı: ' + quoteId);
    QuoteRepository.update(quoteId, { status: 'Onaylandı' });
    const res = ReservationRepository.create({
      leadId:     quote.leadId,
      quoteId:    quote.id,
      customerId: quote.customerId,
      tourId:     quote.tourId,
      tour:       quote.tour,
      date:       quote.dateRange || '',
      time:       '09:00',
      duration:   '',
      pax:        quote.pax,
      pickup:     '', pickupTime: '—',
      total:      quote.total,
      deposit:    Math.round((quote.total || 0) * (quote.depositPct || 25) / 100),
      remaining:  Math.round((quote.total || 0) * (1 - (quote.depositPct || 25) / 100)),
      currency:   quote.currency,
    });
    if (quote.leadId) {
      LeadRepository.update(quote.leadId, { status: 'Onaylandı' });
    }
    ActivityRepository.create({
      entityType: 'reservation', entityId: res.id,
      action: 'created',
      description: `${quoteId} → ${res.id}: Teklif rezervasyona dönüştürüldü`,
    });
    return res;
  },

  send(quoteId) {
    return QuoteRepository.update(quoteId, { status: 'Gönderildi' });
  },
};

const ReservationService = {

  assignGuide(resId, guideName) {
    const res = ReservationRepository.update(resId, {
      guide: guideName,
      opStatus: 'Rehber Atandı',
    });
    ActivityRepository.create({
      entityType: 'reservation', entityId: resId,
      action: 'updated',
      description: `Rehber atandı: ${guideName}`,
    });
    return res;
  },

  complete(resId) {
    const res = ReservationRepository.update(resId, { opStatus: 'Tamamlandı' });
    ActivityRepository.create({
      entityType: 'reservation', entityId: resId,
      action: 'complete',
      description: 'Tur tamamlandı olarak işaretlendi',
    });
    return res;
  },

  cancel(resId, reason = '') {
    const res = ReservationRepository.update(resId, { opStatus: 'İptal' });
    ActivityRepository.create({
      entityType: 'reservation', entityId: resId,
      action: 'cancelled',
      description: `Rezervasyon iptal edildi${reason ? ': ' + reason : ''}`,
    });
    return res;
  },
};

const PaymentService = {

  record({ resId, customerId, amount, currency, paymentType, method, notes }) {
    const statusMap = {
      'Tam Ödeme':    'Tamamlandı',
      'İade':         'İade Edildi',
      'Kapora':       'Kısmi Ödendi',
      'Kalan Ödeme':  'Kısmi Ödendi',
    };
    return PaymentRepository.create({
      resId, customerId,
      amount: parseFloat(amount) || 0,
      currency: currency || 'EUR',
      paymentType: paymentType || 'Kapora',
      method: method || 'Banka Transferi',
      status: statusMap[paymentType] || 'Kısmi Ödendi',
      notes: notes || '',
    });
  },

  getCustomerSummary(customerId) {
    const pays = PaymentRepository.getAll({ customerId });
    return {
      total:     pays.reduce((s, p) => s + (p.amount || 0), 0),
      collected: pays.filter(p => p.status === 'Tamamlandı').reduce((s, p) => s + (p.amount || 0), 0),
      pending:   pays.filter(p => p.status !== 'Tamamlandı' && p.status !== 'İade Edildi').reduce((s, p) => s + (p.amount || 0), 0),
      currency:  pays[0]?.currency || 'EUR',
    };
  },
};

const CustomerService = {

  getProfile(customerId) {
    const customer = CustomerRepository.getById(customerId);
    if (!customer) return null;
    const leads        = LeadRepository.getByCustomerId(customerId);
    const quotes       = QuoteRepository.getByCustomerId(customerId);
    const reservations = ReservationRepository.getByCustomerId(customerId);
    const tasks        = TaskRepository.getAll({ customerId });
    const paymentSummary = PaymentService.getCustomerSummary(customerId);
    const timeline     = ActivityRepository.getAll({ customerId });
    return {
      ...customer,
      leads:        leads.length,
      quotes:       quotes.length,
      reservations: reservations.length,
      openTasks:    tasks.filter(t => t.status !== 'Tamamlandı').length,
      totalSpend:   paymentSummary.collected,
      currency:     paymentSummary.currency,
      relatedLeads: leads.map(l => ({
        date:   l.createdAt,
        source: DB.sources.find(s => s.id === l.sourceId)?.label || l.sourceId,
        tour:   l.tour,
        status: l.status,
        id:     l.id,
      })),
      relatedQuotes: quotes.map(q => ({
        id:     q.id,
        tour:   q.tour,
        amount: `${q.currency === 'TRY' ? '₺' : '€'}${(q.total || 0).toLocaleString('tr-TR')}`,
        status: q.status,
        date:   q.createdAt,
      })),
      relatedReservations: reservations.map(r => ({
        id:       r.id,
        tour:     r.tour,
        date:     r.date,
        pax:      r.pax,
        opStatus: r.opStatus,
        payStatus:r.payStatus,
      })),
      timeline: timeline.map(log => {
        const typeMap = { lead:'lead', quote:'quote', payment:'payment', reservation:'reservation', call:'call', customer:'reply' };
        const staff = DB.staff.find(s => s.id === log.performedBy);
        const dateStr = log.createdAt.split('T')[0].replace(/\d{4}-(\d{2})-(\d{2})/, (_,m,d) =>
          `${d} ${['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'][parseInt(m)-1]}`
        );
        const ACTION_LABELS = {
          created:'Talep oluşturuldu', sent:'Teklif gönderildi', approved:'Teklif onaylandı',
          payment:'Ödeme alındı', deposit:'Kapora alındı', call:'Telefon görüşmesi yapıldı',
          reply:'Müşteri geri döndü', complete:'Tur tamamlandı', updated:'Güncellendi',
          task:'Görev oluşturuldu',
        };
        return {
          date:   dateStr,
          type:   typeMap[log.entityType] || 'lead',
          action: ACTION_LABELS[log.action] || log.description,
          detail: log.description,
          who:    staff?.name || log.performedBy,
          time:   log.createdAt.includes('T') ? log.createdAt.split('T')[1].slice(0,5) : '09:00',
        };
      }),
    };
  },
};

const MetricsService = {
  getDashboard() {
    const openLeads           = LeadRepository.getAll().filter(l => !['Onaylandı','İptal'].includes(l.status));
    const upcomingRes         = ReservationRepository.getAll().filter(r => !['Tamamlandı','İptal'].includes(r.opStatus));
    const pendingPayments     = PaymentRepository.getAll({ currency:'EUR' }).filter(p => ['Bekliyor','Kısmi Ödendi'].includes(p.status));
    const eurPayments         = PaymentRepository.getAll({ currency:'EUR' });
    const collected           = eurPayments.filter(p => p.status !== 'Bekliyor').reduce((s,p)=>s+p.amount,0);
    const expectedRevenue     = eurPayments.reduce((s,p) => {
      const res = ReservationRepository.getById(p.resId || '');
      return s + (res ? res.total : p.amount);
    }, 0);
    return {
      openLeads:            openLeads.length,
      newLeads:             LeadRepository.getAll({ status:'Yeni' }).length,
      upcomingReservations: upcomingRes,
      pendingPaymentsCount: pendingPayments.length,
      pendingPaymentsEUR:   pendingPayments.reduce((s,p) => {
        const res = ReservationRepository.getById(p.resId || '');
        return s + (res ? res.remaining : p.amount);
      }, 0),
      expectedRevenueEUR:   expectedRevenue,
      collectedEUR:         collected,
      noGuideCount:         ReservationRepository.getAll({ noGuide:true }).length,
    };
  },
};

const NAV_TOP = [
  { id:"dashboard",    label:"Ana Sayfa",      badge:null, icon:"M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z M9 21V12h6v9" },
  { id:"leads",        label:"Talepler",        badge:DB.leads.filter(l=>["Yeni","İletişimde"].includes(l.status)).length,    icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
  { id:"customers",    label:"Misafirler",      badge:null, icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" },
  { id:"quotes",       label:"Teklifler",       badge:DB.quotes.filter(q=>q.status==="Taslak").length,    icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" },
  { id:"reservations", label:"Rezervasyonlar",  badge:null, icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
  { id:"calendar",     label:"Takvim",          badge:null, icon:"M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z" },
  { id:"tours",        label:"Turlar",          badge:null, icon:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10" },
];
const NAV_BOT = [
  { id:"tasks",      label:"Görevler",       badge:DB.tasks.filter(t=>t.status!=="Tamamlandı"&&t.dueDateRaw<=0).length,    icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
  { id:"payments",   label:"Ödemeler",      badge:null, icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20" },
  { id:"messages",   label:"Mesajlar",      badge:7,   icon:"M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" },
  { id:"reminders",  label:"Hatırlatmalar", badge:5,    icon:"M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" },
  { id:"reports",    label:"Raporlar",      badge:null, icon:"M18 20V10M12 20V4M6 20v-6" },
  { id:"settings",   label:"Ayarlar",       badge:null, icon:"M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" },
];

const URGENT = [
  {
    id:1, level:"high",
    title:"Sarah Johnson için ödeme takibi yapılmalı",
    sub:"Private Istanbul Experience · 22 Haz · €1.200 bekliyor",
    tag:"Ödeme", tagColor:C.red, tagBg:C.redBg,
    ago:"2 saat önce",
    icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20",
  },
  {
    id:2, level:"high",
    title:"Emma Brown rezervasyonu için rehber atanmalı",
    sub:"Private Istanbul Experience · 25 Haz · 6 kişi",
    tag:"Rehber", tagColor:C.blue, tagBg:C.blueBg,
    ago:"4 saat önce",
    icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75",
  },
  {
    id:3, level:"medium",
    title:"Michael Green için teklif hazırlanmalı",
    sub:"Kapadokya Turu · 3 kişi · Kaynak: Instagram",
    tag:"Teklif", tagColor:C.amber, tagBg:C.amberBg,
    ago:"1 gün önce",
    icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
  },
];

const TODAY_TOURS = DB.reservations
  .filter(r => r.date === "03 Haz 2026" || r.opStatus === "Rehber Atandı" || r.opStatus === "Hazır")
  .slice(0, 4)
  .map(r => {
    const cust = getCustomerById(r.customerId);
    const payMeta = { "Ödendi":{ payColor:C.green,payBg:C.greenBg }, "Kapora Ödendi":{ payColor:C.amber,payBg:C.amberBg }, "Bekliyor":{ payColor:C.red,payBg:C.redBg } };
    const pm = payMeta[r.payStatus] || { payColor:C.textFaint, payBg:C.ivoryDark };
    const gm = r.guide ? { guideColor:C.green, guideBg:C.greenBg } : { guideColor:C.red, guideBg:C.redBg };
    return {
      time:r.time, customer:r.tour, tour:r.tour, pax:r.pax,
      flag: cust?.flag || "🏳", resId: r.id,
      payStatus:r.payStatus, ...pm,
      guideStatus: r.guide ? "Rehber Atandı" : "Rehber Atanmadı", ...gm,
    };
  }); // derived from DB

const UPCOMING_RESERVATIONS = DB.reservations
  .filter(r => !["Tamamlandı","İptal"].includes(r.opStatus))
  .slice(0, 5)
  .map(r => {
    const cust = getCustomerById(r.customerId);
    return {
      date:r.date, day:"", customer:r.tour, flag:cust?.flag||"🏳",
      pax:r.pax, guide:r.guide||"Atanmadı",
      payStatus:r.payStatus, resId:r.id,
    };
  }); // derived from DB

const ACTIVITIES = DB.activityLogs
  .slice(-6)
  .reverse()
  .map(log => {
    const typeMap = {
      lead:        { type:"lead",    icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", color:C.blue },
      quote:       { type:"quote",   icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6", color:C.amber },
      payment:     { type:"payment", icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20", color:C.green },
      reservation: { type:"reservation", icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", color:C.navy },
      call:        { type:"call",    icon:"M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07", color:C.textMuted },
    };
    const meta = typeMap[log.entityType] || typeMap.lead;
    const staff = DB.staff.find(s=>s.id===log.performedBy);
    return {
      ...meta,
      action: log.description,
      who: staff?.name || log.performedBy,
      ago: log.createdAt.includes("T") ? log.createdAt.split("T")[0] : log.createdAt,
      entityId: log.entityId,
    };
  }); // derived from DB.activityLogs

function Ic({ d, size=16, sw=1.6 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function Pill({ label, color, bg, small }) {
  return (
    <span style={{
      display:"inline-flex", alignItems:"center",
      padding: small ? "2px 7px" : "3px 9px",
      borderRadius:99, fontSize: small ? 10.5 : 11.5, fontWeight:500,
      color, background:bg, whiteSpace:"nowrap",
      fontFamily:"'DM Sans',sans-serif",
    }}>{label}</span>
  );
}

function SectionHeader({ title, action, onAction }) {
  return (
    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18}}>
      <h2 style={{
        margin:0, fontSize:16, fontWeight:600, color:C.text,
        fontFamily:"'Playfair Display',serif", letterSpacing:"0.01em",
      }}>{title}</h2>
      {action && (
        <button onClick={onAction} style={{
          background:"none", border:"none", cursor:"pointer",
          fontSize:12.5, color:C.goldLight, fontFamily:"'DM Sans',sans-serif",
          fontWeight:500, display:"flex", alignItems:"center", gap:4,
          padding:0,
        }}>
          {action}
          <Ic d="M9 18l6-6-6-6" size={13} sw={2}/>
        </button>
      )}
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background:C.white, border:`1px solid ${C.border}`,
      borderRadius:12, padding:"22px 24px",
      ...style,
    }}>
      {children}
    </div>
  );
}

function NavItem({ item, currentBase }) {
  const [hov, setHov] = useState(false);
  const on = currentBase === item.id;
  function handleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    // Use NAV_REF.fn — the single canonical navigate set by useHashRouter effect
    if (typeof NAV_REF.fn === 'function') {
      NAV_REF.fn('/' + item.id);
    } else {
      // Absolute fallback
      try { window.location.hash = '#/' + item.id; } catch(_) {}
    }
  }
  return (
    <a href={"#/" + item.id} onClick={handleClick}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      title={item._collapsed ? item.label : undefined}
      style={{
        textDecoration:"none",
        display:"flex", alignItems:"center", gap:10, width:"100%",
        padding: item._collapsed ? "10px 0" : "8.5px 14px",
        justifyContent: item._collapsed ? "center" : "flex-start",
        border:"none", borderRadius:7,
        background: on ? "rgba(184,151,58,0.13)" : hov ? "rgba(255,255,255,0.06)" : "transparent",
        color: on ? C.goldLight : hov ? "rgba(248,245,238,0.9)" : "rgba(248,245,238,0.58)",
        cursor:"pointer", textAlign:"left", position:"relative",
        transition:"background 0.12s, color 0.12s",
      }}>
      {on && <span style={{
        position:"absolute", left:0, top:"50%", transform:"translateY(-50%)",
        width:3, height:20, borderRadius:"0 3px 3px 0", background:C.goldLight,
      }}/>}
      <span style={{flexShrink:0, opacity:on?1:0.85}}>
        <Ic d={item.icon} size={15} sw={on?2:1.6}/>
      </span>
      {!item._collapsed && <span style={{
        fontSize:13, fontWeight:on?500:400, flex:1, letterSpacing:"0.01em",
        fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap",
      }}>{item.label}</span>}
      {!item._collapsed && item.badge && (
        <span style={{
          minWidth:18, height:18, borderRadius:99, padding:"0 5px",
          display:"inline-flex", alignItems:"center", justifyContent:"center",
          fontSize:10.5, fontWeight:600, lineHeight:1,
          background:"rgba(184,151,58,0.18)", color:C.goldLight,
        }}>{item.badge}</span>
      )}
    </a>
  );
}

function SidebarInner({ currentBase, onNavItem }) {
  const auth = getAuthContext();
  const role = auth.role;

  function visibleItems(items) {
    return items.filter(it => canAccess(role, it.id));
  }

  function handleItemClick(itemId) {
    if (typeof NAV_REF.fn === 'function') NAV_REF.fn("/" + itemId);
    else { try { window.location.hash = '#/' + itemId; } catch(_) {} }
    if (onNavItem) onNavItem();
  }
  return (
    <>
      {}
      <div style={{
        padding:"18px 16px 14px",
        borderBottom:"1px solid rgba(255,255,255,0.08)",
        display:"flex", alignItems:"center", gap:10, flexShrink:0,
      }}>
        <img src="/seffafdeselogo.png" alt="Dese Tour"
          style={{height:32, width:"auto", flexShrink:0}}
        />
        <div>
          <div style={{fontSize:13.5, fontWeight:600, color:C.ivory, fontFamily:"'Playfair Display',serif", lineHeight:1.2}}>Dese Tour</div>
          <div style={{fontSize:10, color:"rgba(248,245,238,0.45)", fontFamily:"'DM Sans',sans-serif"}}>Operations Center</div>
        </div>
      </div>

      {}
      <nav style={{flex:1, padding:"10px 10px", overflowY:"auto"}}>
        <div style={{marginBottom:4}}>
          {visibleItems(NAV_TOP).map(it=>(
            <button key={it.id} onClick={()=>handleItemClick(it.id)} style={{
              display:"flex", alignItems:"center", gap:10, width:"100%",
              padding:"9px 14px", border:"none", borderRadius:7, marginBottom:2,
              background: currentBase===it.id ? "rgba(184,151,58,0.13)" : "transparent",
              color: currentBase===it.id ? C.goldLight : "rgba(248,245,238,0.6)",
              cursor:"pointer", textAlign:"left",
              borderLeft: currentBase===it.id ? "3px solid "+C.goldLight : "3px solid transparent",
              transition:"background 0.12s, color 0.12s",
              textDecoration:"none",
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth={currentBase===it.id ? 2 : 1.6}
                strokeLinecap="round" strokeLinejoin="round">
                <path d={it.icon}/>
              </svg>
              <span style={{fontSize:13, fontWeight:currentBase===it.id?500:400, fontFamily:"'DM Sans',sans-serif", flex:1, whiteSpace:"nowrap"}}>{it.label}</span>
              {(()=>{ const b = it.id==="messages" ? (typeof MOCK_CONVERSATIONS!=="undefined"?MOCK_CONVERSATIONS.reduce((s,c)=>s+c.unread,0):it.badge) : it.badge; return b ? <span style={{minWidth:18,height:18,borderRadius:99,padding:"0 5px",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:10.5,fontWeight:600,background:"rgba(184,151,58,0.18)",color:C.goldLight}}>{b}</span> : null; })()}
            </button>
          ))}
        </div>
        <div style={{height:1, background:"rgba(255,255,255,0.07)", margin:"8px 10px"}}/>
        <div>
          {visibleItems(NAV_BOT).map(it=>(
            <button key={it.id} onClick={()=>handleItemClick(it.id)} style={{
              display:"flex", alignItems:"center", gap:10, width:"100%",
              padding:"9px 14px", border:"none", borderRadius:7, marginBottom:2,
              background: currentBase===it.id ? "rgba(184,151,58,0.13)" : "transparent",
              color: currentBase===it.id ? C.goldLight : "rgba(248,245,238,0.6)",
              cursor:"pointer", textAlign:"left",
              borderLeft: currentBase===it.id ? "3px solid "+C.goldLight : "3px solid transparent",
              transition:"background 0.12s, color 0.12s",
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth={currentBase===it.id ? 2 : 1.6}
                strokeLinecap="round" strokeLinejoin="round">
                <path d={it.icon}/>
              </svg>
              <span style={{fontSize:13, fontWeight:currentBase===it.id?500:400, fontFamily:"'DM Sans',sans-serif", flex:1, whiteSpace:"nowrap"}}>{it.label}</span>
              {it.badge ? <span style={{minWidth:18,height:18,borderRadius:99,padding:"0 5px",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:10.5,fontWeight:600,background:"rgba(184,151,58,0.18)",color:C.goldLight}}>{it.badge}</span> : null}
            </button>
          ))}
        </div>
      </nav>

      {}
      <div style={{
        padding:"12px 16px calc(12px + env(safe-area-inset-bottom, 0px))",
        borderTop:"1px solid rgba(255,255,255,0.07)", flexShrink:0,
      }}>
        <div style={{display:"flex", alignItems:"center", gap:9, marginBottom:10}}>
          <div style={{width:30,height:30,borderRadius:"50%",background:"rgba(201,168,76,0.18)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <span style={{fontSize:11,fontWeight:700,color:C.goldLight,fontFamily:"'DM Sans',sans-serif"}}>{auth.initials}</span>
          </div>
          <div style={{minWidth:0}}>
            <div style={{fontSize:12.5,fontWeight:500,color:C.ivory,fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{auth.displayName}</div>
            <div style={{fontSize:10.5,color:"rgba(248,245,238,0.4)",fontFamily:"'DM Sans',sans-serif"}}>{auth.role}</div>
          </div>
        </div>
        <button onClick={()=>auth.logout()} style={{
          display:"flex", alignItems:"center", gap:8, width:"100%",
          minHeight:40, padding:"8px 10px", border:"none", borderRadius:7,
          background:"rgba(255,255,255,0.04)", color:"rgba(248,245,238,0.5)",
          cursor:"pointer", textAlign:"left", fontSize:12.5,
          fontFamily:"'DM Sans',sans-serif",
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
          </svg>
          Çıkış Yap
        </button>
      </div>
    </>
  );
}

function Sidebar({ currentBase, collapsed, onToggle, mobileOpen, onMobileClose }) {
  const auth = getAuthContext();
  const { isMobile } = useBreakpoint();
  const W = collapsed ? 64 : 208;

  // Lock body scroll while the mobile drawer is open so the page behind it
  // can't be scrolled/dragged — the drawer must feel modal, not overlaid.
  useEffect(() => {
    if (!isMobile) return;
    if (mobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [isMobile, mobileOpen]);

  if (isMobile) {
    return (
      <>
        {}
        {mobileOpen && (
          <div onClick={onMobileClose} style={{
            position:"fixed", inset:0, zIndex:299,
            background:"rgba(0,0,0,0.45)", backdropFilter:"blur(2px)",
          }}/>
        )}
        {}
        <aside style={{
          position:"fixed", top:0, left:0, bottom:0, width:"min(240px, 82vw)",
          paddingTop:"env(safe-area-inset-top, 0px)",
          background:`linear-gradient(180deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
          zIndex:300, display:"flex", flexDirection:"column",
          transform: mobileOpen ? "translateX(0)" : "translateX(-100%)",
          transition:"transform 0.25s cubic-bezier(0.4,0,0.2,1)",
          boxShadow:"4px 0 24px rgba(0,0,0,0.35)",
          visibility: mobileOpen ? "visible" : "hidden",
        }}>
          <SidebarInner currentBase={currentBase} onNavItem={onMobileClose}/>
        </aside>
      </>
    );
  }

  return (
    <aside style={{
      position:"fixed", top:0, left:0, bottom:0, width:W,
      background:`linear-gradient(180deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
      display:"flex", flexDirection:"column", zIndex:50,
      boxShadow:"3px 0 24px rgba(15,29,53,0.28)",
      transition:"width 0.22s cubic-bezier(0.4,0,0.2,1)",
      overflow:"hidden",
    }}>
      {}
      <button onClick={onToggle}
        title={collapsed?"Menüyü Genişlet":"Menüyü Kapat"}
        style={{
          position:"absolute", top:"50%", right:-16,
          transform:"translateY(-50%)",
          width:16, height:48, zIndex:10,
          background:C.navy,
          border:`1px solid rgba(201,168,76,0.35)`,
          borderLeft:"none",
          borderRadius:"0 8px 8px 0",
          display:"flex", alignItems:"center", justifyContent:"center",
          cursor:"pointer",
          boxShadow:"3px 0 8px rgba(15,29,53,0.25)",
        }}>
        {}
        <svg width="9" height="14" viewBox="0 0 9 14" fill="none"
          stroke={C.goldLight} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {collapsed
            ? <path d="M2 2l5 5-5 5M2 2l5 5-5 5" transform="translate(0,-3)"/>
            : <path d="M7 2L2 7l5 5M7 2L2 7l5 5" transform="translate(0,-3)"/>
          }
        </svg>
      </button>
      <div style={{padding:"20px 16px 14px", borderBottom:"1px solid rgba(255,255,255,0.08)"}}>
        {}
        <img
          src="/seffafdeselogo.png"
          alt="Dese Tour"
          style={{
            width:"100%", maxWidth:168,
            height:"auto", display:"block",
            mixBlendMode:"screen",
            opacity:0.95,
          }}
        />
        <div style={{
          fontSize:9, letterSpacing:"0.18em", textTransform:"uppercase",
          color:C.goldLight, fontFamily:"'DM Sans',sans-serif", fontWeight:500,
          marginTop:10, paddingLeft:2,
        }}>Operations Center</div>
      </div>
      <nav style={{padding:"10px 10px 0", display:"flex", flexDirection:"column", gap:1}}>
        {NAV_TOP.map(it=><NavItem key={it.id} item={{...it,_collapsed:collapsed}} currentBase={currentBase}/>)}
      </nav>
      <div style={{height:1, background:"rgba(255,255,255,0.07)", margin:"10px 18px"}}/>
      <nav style={{padding:"0 10px", display:"flex", flexDirection:"column", gap:1}}>
        {NAV_BOT.map(it=><NavItem key={it.id} item={{...it,_collapsed:collapsed}} currentBase={currentBase}/>)}

        {}
        <div style={{padding:"8px 10px", borderTop:"1px solid rgba(255,255,255,0.07)", marginTop:4}}>
          <button onClick={()=>auth.logout()} style={{
            display:"flex", alignItems:"center", gap:9, width:"100%",
            padding:"8px 14px", border:"none", borderRadius:7,
            background:"transparent", color:"rgba(248,245,238,0.45)",
            cursor:"pointer", textAlign:"left", transition:"color .12s, background .12s",
          }}
            onMouseEnter={e=>{e.currentTarget.style.background="rgba(220,38,38,0.15)";e.currentTarget.style.color="#FCA5A5";}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color="rgba(248,245,238,0.45)";}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
            </svg>
            <span style={{fontSize:13, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}>Çıkış Yap</span>
          </button>
        </div>
      </nav>
      <div style={{flex:1}}/>
      <div style={{
        padding:"12px 10px", borderTop:"1px solid rgba(255,255,255,0.08)",
        display:"flex", alignItems:"center",
        gap: collapsed ? 0 : 10,
        justifyContent: collapsed ? "center" : "flex-start",
        overflow:"hidden",
      }}>
        <div style={{
          width:34, height:34, borderRadius:"50%", flexShrink:0,
          background:"rgba(184,151,58,0.15)", border:"1.5px solid rgba(184,151,58,0.35)",
          display:"flex", alignItems:"center", justifyContent:"center",
        }}>
          <span style={{fontSize:12, fontWeight:600, color:C.goldLight, fontFamily:"'DM Sans',sans-serif"}}>{auth.initials}</span>
        </div>
        {!collapsed && (
          <div style={{overflow:"hidden"}}>
            <div style={{fontSize:12.5, fontWeight:500, color:C.ivory, fontFamily:"'DM Sans',sans-serif", lineHeight:1.3, whiteSpace:"nowrap"}}>{auth.displayName}</div>
            <div style={{fontSize:11, color:"rgba(184,151,58,0.65)", fontFamily:"'DM Sans',sans-serif"}}>{auth.role}</div>
          </div>
        )}
      </div>
      {!collapsed && (
        <div style={{padding:"6px 16px 12px", textAlign:"center"}}>
          <div style={{fontSize:10, color:"rgba(248,245,238,0.22)", fontFamily:"'DM Sans',sans-serif"}}>© 2026 Dese Tour · Tüm hakları saklıdır.</div>
        </div>
      )}
    </aside>
  );
}

function Welcome() {
  const auth = getAuthContext();
  const firstName = auth.displayName.split(" ")[0] || "Hoş geldiniz";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Günaydın" : hour < 18 ? "İyi günler" : "İyi akşamlar";
  return (
    <div style={{
      background: C.white,
      border:`1px solid ${C.border}`,
      borderRadius:12,
      padding:"24px 28px",
      display:"flex", alignItems:"center", justifyContent:"space-between", gap:24,
    }}>
      <div>
        <div style={{
          fontSize:11, letterSpacing:"0.12em", textTransform:"uppercase",
          color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginBottom:6,
        }}>
          {new Date().toLocaleDateString("tr-TR",{day:"2-digit",month:"long",year:"numeric",weekday:"long"})}
        </div>
        <h1 style={{
          margin:0, fontSize:26, fontWeight:700, color:C.text,
          fontFamily:"'Playfair Display',serif", lineHeight:1.2,
        }}>
          {greeting}, {firstName} 👋
        </h1>
        <p style={{
          margin:"6px 0 0", fontSize:13.5, color:C.textMuted,
          fontFamily:"'DM Sans',sans-serif", lineHeight:1.5,
        }}>
          Bugünkü operasyon özetiniz — <span style={{color:C.amber, fontWeight:500}}>3 acil işlem</span> dikkat bekliyor.
        </p>
      </div>

      {}
      <button style={{
        display:"flex", alignItems:"center", gap:8,
        padding:"10px 18px", borderRadius:8, flexShrink:0,
        border:`1.5px solid ${C.gold}`, background:C.goldPale,
        cursor:"pointer", color:C.gold,
        fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
        transition:"background 0.12s",
      }}
        onMouseEnter={e=>e.currentTarget.style.background=C.gold === C.gold ? "#EDE3C0" : C.goldPale}
        onMouseLeave={e=>e.currentTarget.style.background=C.goldPale}
      >
        <Ic d="M12 5v14M5 12h14" size={15} sw={2}/>
        Yeni Talep Ekle
      </button>
    </div>
  );
}

const KPI_DATA = [
  {
    label:"Bugünkü Turlar",
    value:String(METRICS.todayTourCount),
    sub:`Toplam ${METRICS.todayTours.reduce((s,r)=>s+r.pax,0)} misafir`,
    icon:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10",
    accent: false,
  },
  {
    label:"Yeni Talepler",
    value:String(METRICS.openLeads),
    sub:"Aktif talepler",
    icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    alert: METRICS.openLeads > 0,
  },
  {
    label:"Bekleyen Ödemeler",
    value:`€${METRICS.pendingPaymentsEUR.toLocaleString("tr-TR")}`,
    sub:`${METRICS.pendingPaymentsCount} rezervasyon`,
    icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20",
    alert: METRICS.pendingPaymentsCount > 0,
  },
  {
    label:"Yaklaşan Rezervasyonlar",
    value:String(METRICS.upcomingReservations.length),
    sub:"Onaylı rezervasyonlar",
    icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11",
  },
  {
    label:"Bu Ay Beklenen Ciro",
    value:`€${METRICS.expectedRevenueEUR.toLocaleString("tr-TR")}`,
    sub:`€${METRICS.collectedEUR.toLocaleString("tr-TR")} tahsil edildi`,
    icon:"M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
    progress: METRICS.expectedRevenueEUR > 0 ? Math.round(METRICS.collectedEUR/METRICS.expectedRevenueEUR*100) : 0,
  },
]; // values derived from DB via METRICS

function KpiCard({ kpi }) {
  return (
    <div style={{
      background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
      padding:"18px 20px", display:"flex", flexDirection:"column", gap:12,
      position:"relative", overflow:"hidden",
    }}>
      {}
      <div style={{display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:10}}>
        <div style={{
          width:40, height:40, borderRadius:10, flexShrink:0,
          background: kpi.alert ? C.redBg : C.goldPale,
          display:"flex", alignItems:"center", justifyContent:"center",
          color: kpi.alert ? C.red : C.gold,
        }}>
          <Ic d={kpi.icon} size={18} sw={1.6}/>
        </div>
        {kpi.alert && (
          <div style={{
            width:8, height:8, borderRadius:"50%",
            background:C.red, marginTop:4, flexShrink:0,
          }}/>
        )}
      </div>

      {}
      <div>
        <div style={{
          fontSize:26, fontWeight:700, color: kpi.alert ? C.red : C.text,
          fontFamily:"'Playfair Display',serif", lineHeight:1, marginBottom:4,
        }}>{kpi.value}</div>
        <div style={{fontSize:12, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>{kpi.label}</div>
      </div>

      {}
      {kpi.progress != null ? (
        <div>
          <div style={{height:3, background:C.ivoryDark, borderRadius:99, overflow:"hidden", marginBottom:4}}>
            <div style={{width:`${kpi.progress}%`, height:"100%", background:C.gold, borderRadius:99}}/>
          </div>
          <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{kpi.sub}</div>
        </div>
      ) : (
        <div style={{
          fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
          paddingTop:4, borderTop:`1px solid ${C.borderLight}`,
        }}>{kpi.sub}</div>
      )}
    </div>
  );
}

function KpiRow() {
  const { data:repoLeads, loading:kpiLoadL }  = useRepo("lead",        "getAll");
  const { data:repoRes,   loading:kpiLoadR }  = useRepo("reservation", "getAll");
  const { data:repoPays,  loading:kpiLoadP }  = useRepo("payment",     "getAll");
  const { data:repoTasks, loading:kpiLoadT }  = useRepo("task",        "getAll");
  const kpiLoading = kpiLoadL || kpiLoadR || kpiLoadP || kpiLoadT;
  const m = calculateDashboardMetrics(repoLeads, repoRes, repoPays, repoTasks, null);
  const kpis = [
    {
      label:"Bugünkü Turlar",
      value: kpiLoading ? '…' : String(m.todayTourCount),
      sub:`${m.todayTourPax} misafir bugün`,
      icon:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10",
      accent:false,
    },
    {
      label:"Yeni Talepler",
      value:String(m.openLeadsCount),
      sub:"Aktif talepler",
      icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
      alert:m.openLeadsCount>0,
    },
    {
      label:"Bekleyen Ödemeler",
      value:`€${m.pendingEUR.toLocaleString("tr-TR",{maximumFractionDigits:0})}`,
      sub:`${m.pendingPaysCount} rezervasyon`,
      icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20",
      alert:m.pendingPaysCount>0,
    },
    {
      label:"Yaklaşan Rezervasyonlar",
      value:String(m.upcomingCount),
      sub:m.upcomingCount>0?"Aktif rezervasyonlar":"Bekleyen yok",
      icon:"M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
      accent:false,
    },
    {
      label:"Bu Ay Beklenen Ciro",
      value:`€${m.monthRevEUR.toLocaleString("tr-TR",{maximumFractionDigits:0})}`,
      sub:"Bu ay",
      icon:"M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
      accent:true,
    },
  ];
  return (
    <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:14}}>
      {kpis.map((k,i)=><KpiCard key={i} kpi={k}/>)}
    </div>
  );
}

function UrgentPanel() {
  const [dismissed, setDismissed] = useState([]);
  const { data:repoLeads }     = useRepo("lead",        "getAll");
  const { data:repoRes }       = useRepo("reservation", "getAll");
  const { data:repoPays }      = useRepo("payment",     "getAll");
  const { data:repoTasks }     = useRepo("task",        "getAll");
  const { data:repoRems }      = useRepo("reminder",    "getAll");
  const urgentItems = useMemo(
    () => computeUrgent(repoLeads, repoRes, repoPays, repoTasks, repoRems),
    [repoLeads, repoRes, repoPays, repoTasks, repoRems]
  );
  const visible = urgentItems.filter(u=>!dismissed.includes(u.id));

  return (
    <Card style={{padding:"20px 22px"}}>
      <SectionHeader
        title="Acil İşler"
        action="Tümünü Gör"
      />

      {visible.length === 0 ? (
        <div style={{
          padding:"28px 0", textAlign:"center",
          color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontSize:13.5,
        }}>
          <div style={{fontSize:28, marginBottom:8, opacity:0.4}}>✓</div>
          Tüm acil işler tamamlandı.
        </div>
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:10}}>
          {visible.map(item=>(
            <div key={item.id} style={{
              display:"flex", alignItems:"flex-start", gap:14,
              padding:"14px 16px", borderRadius:10,
              background: item.level === "high" ? C.redBg : C.amberBg,
              border:`1px solid ${item.level === "high" ? "rgba(192,57,43,0.15)" : "rgba(180,83,9,0.15)"}`,
              position:"relative",
            }}>
              {}
              <div style={{
                position:"absolute", left:0, top:0, bottom:0, width:3,
                borderRadius:"10px 0 0 10px",
                background: item.level === "high" ? C.red : C.amber,
              }}/>

              {}
              <div style={{
                width:36, height:36, borderRadius:8, flexShrink:0,
                background:C.white,
                display:"flex", alignItems:"center", justifyContent:"center",
                color: item.level === "high" ? C.red : C.amber,
                boxShadow:"0 1px 4px rgba(0,0,0,0.06)",
              }}>
                <Ic d={item.icon} size={16} sw={1.7}/>
              </div>

              {}
              <div style={{flex:1, minWidth:0}}>
                <div style={{
                  fontSize:13.5, fontWeight:500, color:C.text,
                  fontFamily:"'DM Sans',sans-serif", lineHeight:1.4, marginBottom:4,
                }}>{item.title}</div>
                <div style={{
                  fontSize:12, color:C.textMuted,
                  fontFamily:"'DM Sans',sans-serif", lineHeight:1.5,
                }}>{item.sub}</div>
                <div style={{display:"flex", alignItems:"center", gap:8, marginTop:8}}>
                  <Pill label={item.tag} color={item.tagColor} bg="rgba(255,255,255,0.8)" small/>
                  <span style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{item.ago}</span>
                </div>
              </div>

              {}
              <div style={{display:"flex", alignItems:"center", gap:6, flexShrink:0}}>
                <button style={{
                  padding:"6px 12px", borderRadius:6, cursor:"pointer",
                  border:`1px solid ${item.level==="high"?C.red:C.amber}`,
                  background:C.white,
                  color:item.level==="high"?C.red:C.amber,
                  fontSize:12, fontWeight:500, fontFamily:"'DM Sans',sans-serif",
                }}>
                  İşleme Al
                </button>
                <button
                  onClick={()=>setDismissed(d=>[...d,item.id])}
                  style={{
                    width:28, height:28, borderRadius:6, cursor:"pointer",
                    border:`1px solid rgba(0,0,0,0.1)`, background:"rgba(255,255,255,0.6)",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    color:C.textMuted,
                  }}>
                  <Ic d="M18 6L6 18 M6 6l12 12" size={13} sw={2}/>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function TodayTours() {
  const { isMobile } = useBreakpoint();
  const { data:repoRes, loading:ttLoading } = useRepo("reservation", "getAll");
  const allRes    = repoRes ?? [];
  const todayList = allRes.filter(r => r.date===_TODAY_STR || r.checkIn===_TODAY_ISO);
  // Supabase mode: render the real, today-filtered reservations — never the
  // static mock catalog (which was previously always shown regardless of
  // loading state or actual data).
  const _payMeta = { "Ödendi":{color:C.green,bg:C.greenBg}, "Kapora Ödendi":{color:C.amber,bg:C.amberBg}, "Bekliyor":{color:C.red,bg:C.redBg} };
  const rows = AppConfig.useSupabase
    ? todayList.map(r => {
        const pm = _payMeta[r.payStatus] || { color:C.textFaint, bg:C.ivoryDark };
        return {
          time: r.time, customer: r.name || r.tour, tour: r.tour, pax: r.pax,
          flag: "🌍", resId: r.id,
          payStatus: r.payStatus, payColor: pm.color, payBg: pm.bg,
          guideStatus: r.guide ? "Rehber Atandı" : "Rehber Atanmadı",
          guideColor:  r.guide ? C.green : C.red,
          guideBg:     r.guide ? C.greenBg : C.redBg,
        };
      })
    : TODAY_TOURS;
  return (
    <Card>
      <SectionHeader title="Bugünkü Turlar" action="Takvimi Gör"/>
      {ttLoading  ? <LoadingState label="Yükleniyor…"/> : null}
      {!ttLoading && rows.length === 0 && (
        <div style={{padding:"28px 0", textAlign:"center", color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontSize:13.5}}>
          Bugün için planlanmış tur bulunmuyor.
        </div>
      )}
      {!ttLoading && rows.length > 0 && isMobile && (
        <div style={{display:"flex", flexDirection:"column", gap:10}}>
          {rows.map((t,i)=>(
            <div key={i} style={{
              border:`1px solid ${C.borderLight}`, borderRadius:10, padding:"12px 14px",
              display:"flex", flexDirection:"column", gap:8,
            }}>
              <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", gap:8}}>
                <div style={{display:"flex", alignItems:"center", gap:8, minWidth:0}}>
                  <span style={{fontSize:13.5, fontWeight:700, color:C.navy, fontFamily:"'Playfair Display',serif", flexShrink:0}}>{t.time}</span>
                  <span style={{fontSize:15, flexShrink:0}}>{t.flag}</span>
                  <span style={{fontSize:13.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{t.customer}</span>
                </div>
                <div style={{display:"flex", alignItems:"center", gap:4, flexShrink:0}}>
                  <Ic d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" size={12} sw={1.5}/>
                  <span style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{t.pax}</span>
                </div>
              </div>
              <div style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{t.tour}</div>
              <div style={{display:"flex", alignItems:"center", gap:8, flexWrap:"wrap"}}>
                <Pill label={t.payStatus} color={t.payColor} bg={t.payBg} small/>
                <Pill label={t.guideStatus} color={t.guideColor} bg={t.guideBg} small/>
              </div>
            </div>
          ))}
        </div>
      )}
      {!ttLoading && rows.length > 0 && !isMobile && <div style={{display:"flex", flexDirection:"column", gap:0}}>
        {}
        <div style={{
          display:"grid",
          gridTemplateColumns:"80px 1fr 1fr 80px 140px 140px",
          gap:12, padding:"0 0 10px",
          borderBottom:`1px solid ${C.border}`,
        }}>
          {["Saat","Misafir","Tur","Kişi","Ödeme","Rehber"].map(h=>(
            <div key={h} style={{
              fontSize:10.5, fontWeight:500, color:C.textFaint,
              fontFamily:"'DM Sans',sans-serif",
              textTransform:"uppercase", letterSpacing:"0.07em",
            }}>{h}</div>
          ))}
        </div>

        {rows.map((t,i)=>{
          const isLast = i === rows.length-1;
          return (
            <div key={i}
              onMouseEnter={e=>e.currentTarget.style.background=C.ivory}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}
              style={{
                display:"grid",
                gridTemplateColumns:"80px 1fr 1fr 80px 140px 140px",
                gap:12,
                padding:"14px 0",
                borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
                borderRadius:6,
                background:"transparent",
                transition:"background 0.1s",
                cursor:"pointer",
                margin:"0 -4px", padding:"14px 4px",
              }}>
              {}
              <div style={{display:"flex", alignItems:"center"}}>
                <span style={{
                  fontSize:13.5, fontWeight:600, color:C.navy,
                  fontFamily:"'Playfair Display',serif",
                }}>{t.time}</span>
              </div>

              {}
              <div style={{display:"flex", alignItems:"center", gap:8}}>
                <span style={{fontSize:15}}>{t.flag}</span>
                <div>
                  <div style={{fontSize:13.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{t.customer}</div>
                </div>
              </div>

              {}
              <div style={{display:"flex", alignItems:"center"}}>
                <span style={{
                  fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif",
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                }}>{t.tour}</span>
              </div>

              {}
              <div style={{display:"flex", alignItems:"center", gap:5}}>
                <Ic d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" size={13} sw={1.5}/>
                <span style={{fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{t.pax}</span>
              </div>

              {}
              <div style={{display:"flex", alignItems:"center"}}>
                <Pill label={t.payStatus} color={t.payColor} bg={t.payBg} small/>
              </div>

              {}
              <div style={{display:"flex", alignItems:"center"}}>
                <Pill label={t.guideStatus} color={t.guideColor} bg={t.guideBg} small/>
              </div>
            </div>
          );
        })}
      </div>}
    </Card>
  );
}

function UpcomingResRow({ r, isLast }) {
  return (
    <div key={r.id}
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"grid", gridTemplateColumns:"56px 1fr 80px 120px",
        gap:12, padding:"14px 0",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        background:"transparent",
        transition:"background 0.1s", cursor:"pointer",
        margin:"0 -4px", paddingLeft:4, paddingRight:4,
      }}>
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"rgba(27,45,79,0.06)",borderRadius:8,padding:"6px 4px"}}>
        <span style={{fontSize:11.5,fontWeight:700,color:C.navy,fontFamily:"'DM Sans',sans-serif",lineHeight:1}}>{(r.date||"—").split(" ")[0]}</span>
        <span style={{fontSize:10,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",lineHeight:1,marginTop:2}}>{(r.date||"—").split(" ")[1]||""}</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",justifyContent:"center",minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
          <span style={{fontSize:11}}>{r.flag||"🌍"}</span>
          <span style={{fontSize:13.5,fontWeight:500,color:C.text,fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.customer||r.name||"—"}</span>
        </div>
        <span style={{fontSize:12,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.tour||"—"}</span>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:4}}>
        <Ic d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" size={12} sw={1.5}/>
        <span style={{fontSize:13,color:C.textMid,fontFamily:"'DM Sans',sans-serif"}}>{r.pax||1} kişi</span>
      </div>
      <div style={{display:"flex",alignItems:"center"}}>
        <Pill label={r.opStatus||"Hazırlanıyor"} color={C.blue} bg={C.blueBg} small/>
      </div>
    </div>
  );
}

function UpcomingReservations() {
  const { data:repoRes, loading:upLoading } = useRepo("reservation", "getAll");
  const allRes     = repoRes ?? [];
  const upcoming   = allRes
    .filter(r => !["Tamamlandı","İptal"].includes(r.opStatus))
    .slice(0,5)
    .map(r => {
      const cust = getCustomerById(r.customerId);
      return { ...r, flag:cust?.flag||"🏳", customer:r.name||cust?.name||r.tour };
    });
  return (
    <Card>
      <SectionHeader title="Yaklaşan Rezervasyonlar" action="Tümünü Gör"/>
      {upLoading  ? <LoadingState label="Yükleniyor…"/> : null}
      <div style={{display:"flex", flexDirection:"column", gap:0}}>
        {upcoming.map((r,i)=>(
          <UpcomingResRow key={i} r={r} isLast={i===upcoming.length-1}/>
        ))}
      </div>
    </Card>
  );
}

const ACTION_LABELS = {
  lead:        "Talep",
  quote:       "Teklif",
  payment:     "Ödeme",
  reservation: "Rezervasyon",
};

function ActivityFeed() {
  const { data:repoActivities, loading:actLoading } = useRepo("activity", "getAll", { limit:6 });
  const TYPE_MAP = {
    lead:        { type:"lead",        icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", color:C.blue },
    quote:       { type:"quote",       icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6", color:C.amber },
    payment:     { type:"payment",     icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20", color:C.green },
    reservation: { type:"reservation", icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", color:C.navy },
    customer:    { type:"customer",    icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75", color:C.textMid },
    task:        { type:"task",        icon:"M9 11l3 3L22 4", color:C.amber },
    call:        { type:"call",        icon:"M22 16.92v3a2 2 0 01-2.18 2A19.79 19.79 0 013.07 9.81", color:C.textMid },
  };
  // Supabase mode: while loading (repoActivities===null) or genuinely empty,
  // never fall back to the hardcoded DB.activityLogs mock feed — that caused
  // the dashboard to briefly show fabricated activity that then vanished
  // once the real (possibly empty) Supabase result arrived.
  const feedItems = repoActivities
    ? repoActivities.slice(0,6).map(a => {
        const tm = TYPE_MAP[a.type||a.entityType] || TYPE_MAP.task;
        return { ...a, ...tm, detail:a.description||a.detail, date:a.date||"—", time:a.time||"—", who:a.who||"—" };
      })
    : (AppConfig.useSupabase ? [] : DB.activityLogs.slice(-6).reverse().map((log,i) => {
        const tm = TYPE_MAP[log.entityType||"task"] || TYPE_MAP.task;
        const dt = new Date(log.createdAt||Date.now());
        return { ...log, ...tm, detail:log.description, date:dt.toLocaleDateString("tr-TR",{day:"2-digit",month:"short"}), time:dt.toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit"}), who:"—" };
      }));

  return (
    <Card>
      <SectionHeader title="Son Aktiviteler" action="Tümünü Gör"/>
      <div style={{position:"relative", paddingLeft:20}}>
        {}
        <div style={{
          position:"absolute", left:7, top:8, bottom:8,
          width:1, background:C.borderLight,
        }}/>
        {actLoading  ? <LoadingState label="Yükleniyor…"/> : null}
        {!actLoading && feedItems.length === 0 && (
          <div style={{padding:"12px 0 4px", color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontSize:13}}>
            Henüz aktivite kaydı yok.
          </div>
        )}
        {feedItems.map((a,i)=>(
          <div key={i} style={{
            display:"flex", alignItems:"flex-start", gap:14,
            paddingBottom: i<feedItems.length-1 ? 18 : 0,
            position:"relative",
          }}>
            {}
            <div style={{
              width:14, height:14, borderRadius:"50%", flexShrink:0,
              background:a.dot, border:`2px solid ${C.white}`,
              position:"absolute", left:-20, top:3,
              boxShadow:`0 0 0 2px ${a.dot}30`,
            }}/>

            {}
            <div style={{
              width:32, height:32, borderRadius:8, flexShrink:0,
              background:C.ivory, border:`1px solid ${C.borderLight}`,
              display:"flex", alignItems:"center", justifyContent:"center",
              color:C.textMuted,
            }}>
              <Ic d={a.icon} size={14} sw={1.5}/>
            </div>

            {}
            <div style={{flex:1, minWidth:0, paddingTop:2}}>
              <div style={{display:"flex", alignItems:"baseline", gap:8, flexWrap:"wrap"}}>
                <span style={{
                  fontSize:13.5, fontWeight:500, color:C.text,
                  fontFamily:"'DM Sans',sans-serif",
                }}>{a.action}</span>
                <span style={{
                  fontSize:11, color:C.textFaint,
                  fontFamily:"'DM Sans',sans-serif",
                }}>{a.ago}</span>
              </div>
              <div style={{
                fontSize:12.5, color:C.textMuted,
                fontFamily:"'DM Sans',sans-serif",
                marginTop:3, lineHeight:1.5,
              }}>{a.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Dashboard() {
  return (
    <div style={{display:"flex", flexDirection:"column", gap:20}}>
      {}
      <Welcome/>

      {}
      <KpiRow/>

      {}
      <div className="rsp-split" style={{display:"grid", gridTemplateColumns:"380px 1fr", gap:20, alignItems:"start"}}>
        <UrgentPanel/>
        <TodayTours/>
      </div>

      {}
      <div className="rsp-split" style={{display:"grid", gridTemplateColumns:"1fr 400px", gap:20, alignItems:"start"}}>
        <UpcomingReservations/>
        <ActivityFeed/>
      </div>
    </div>
  );
}

const STATUS_META = {
  "Yeni":                 { color:"#1A6FAE", bg:"#E8F2FB" },
  "Görüşüldü":            { color:"#B45309", bg:"#FEF3E2" },
  "Teklif Hazırlanıyor":  { color:"#6B3FA0", bg:"#F3EEF9" },
  "Teklif Gönderildi":    { color:"#B8973A", bg:"#F5EDD4" },
  "Ödeme Bekleniyor":     { color:"#C05621", bg:"#FEF0E8" },
  "Onaylandı":            { color:"#2E7D52", bg:"#EBF5EF" },
  "İptal":                { color:"#C0392B", bg:"#FDECEC" },
};

const SOURCE_META = {
  "Booking":      { color:"#003580", bg:"#E5EDF8", icon:"M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" },
  "WhatsApp":     { color:"#128C7E", bg:"#E7F5F3", icon:"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" },
  "Website":      { color:"#2E7D52", bg:"#EBF5EF", icon:"M12 2a10 10 0 100 20A10 10 0 0012 2zm0 2c1.08 0 2.1.2 3.04.55L13 6.5h-2l-2.04-1.95A8 8 0 0112 4zm-6.5 3.5L7 9v2l-2.95.5A8.02 8.02 0 015.5 7.5zM4.07 13H7l1 3-1.5 1.5A8.01 8.01 0 014.07 13zm4.43 6.5L10 18h4l1.5 1.5A8 8 0 018.5 19.5zM17 15l1-3h2.93a8.01 8.01 0 01-1.43 4.5L17 15zm2.45-5L17 9V7.5a8.02 8.02 0 012.45 2.5z" },
  "Telefon":      { color:"#4A5568", bg:"#F0EEF5", icon:"M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.09-1.09a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" },
  "Instagram":    { color:"#C13584", bg:"#FAEAF5", icon:"M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" },
  "Manuel":       { color:"#8A8070", bg:"#F3F1ED", icon:"M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
  "Tripadvisor":  { color:"#34E0A1", bg:"#E6FBF5", icon:"M12 2a10 10 0 100 20A10 10 0 0012 2z" },
  "Civitatis":    { color:"#D2492A", bg:"#FBEAE4", icon:"M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z" },
};

const MOCK_LEADS = DB.leads; // → centralized DB

const STATUS_TABS = [
  "Tümü","Yeni","Görüşüldü","Teklif Hazırlanıyor",
  "Teklif Gönderildi","Ödeme Bekleniyor","Onaylandı","İptal",
];

const SOURCE_FILTERS = ["Tümü","Booking","Civitatis","WhatsApp","Website","Telefon","Instagram","Manuel","Tripadvisor"];

function SourceBadge({ source }) {
  const m = SOURCE_META[source] || SOURCE_META["Manuel"];
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding:"3px 8px", borderRadius:6,
      background:m.bg, color:m.color,
      fontSize:11.5, fontWeight:500,
      fontFamily:"'DM Sans',sans-serif",
      whiteSpace:"nowrap", border:`1px solid ${m.color}18`,
    }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill={m.color}>
        <path d={m.icon}/>
      </svg>
      {source}
    </span>
  );
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { color:C.textMuted, bg:C.ivoryDark };
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding:"4px 10px", borderRadius:99,
      background:m.bg, color:m.color,
      fontSize:11.5, fontWeight:500,
      fontFamily:"'DM Sans',sans-serif",
      whiteSpace:"nowrap",
    }}>
      <span style={{
        width:6, height:6, borderRadius:"50%",
        background:m.color, flexShrink:0,
        opacity:0.85,
      }}/>
      {status}
    </span>
  );
}

function AssigneeChip({ name, initials }) {
  if (!initials) {
    return (
      <span style={{
        fontSize:12, color:C.textFaint,
        fontFamily:"'DM Sans',sans-serif",
        fontStyle:"italic",
      }}>Atanmadı</span>
    );
  }
  return (
    <div style={{display:"flex", alignItems:"center", gap:7}}>
      <div style={{
        width:26, height:26, borderRadius:"50%", flexShrink:0,
        background:"rgba(27,45,79,0.09)",
        border:`1.5px solid rgba(27,45,79,0.14)`,
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>
        <span style={{fontSize:10, fontWeight:600, color:C.navy, fontFamily:"'DM Sans',sans-serif"}}>{initials}</span>
      </div>
      <span style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}>{name}</span>
    </div>
  );
}

function LeadRow({ lead, isLast, onSelect }) {
  const isNew = lead.status === "Yeni";
  const isUrgent = lead.status === "Ödeme Bekleniyor";

  return (
    <tr
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={() => onSelect && onSelect(lead.id)}
      style={{
        background:C.white,
        cursor:"pointer",
        transition:"background 0.1s",
      }}
    >
      {}
      <td style={{
        padding:"15px 16px 15px 20px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <div style={{display:"flex", alignItems:"center", gap:10}}>
          {}
          <div style={{
            width:3, height:36, borderRadius:99, flexShrink:0,
            background: isNew ? C.blue : isUrgent ? C.red : "transparent",
          }}/>
          <div>
            <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:2}}>
              <span style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{lead.name}</span>
              {isNew && (
                <span style={{
                  fontSize:9.5, fontWeight:600, color:C.blue,
                  background:C.blueBg, borderRadius:4, padding:"1px 5px",
                  fontFamily:"'DM Sans',sans-serif", letterSpacing:"0.04em",
                  textTransform:"uppercase",
                }}>YENİ</span>
              )}
            </div>
            <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
              {lead.id} · {lead.flag} {lead.country}
            </div>
          </div>
        </div>
      </td>

      {}
      <td style={{
        padding:"15px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <SourceBadge source={lead.source}/>
      </td>

      {}
      <td style={{
        padding:"15px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle", maxWidth:200,
      }}>
        <div style={{fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif", fontWeight:500, lineHeight:1.4}}>{lead.tour}</div>
        <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2}}>{lead.dateRange}</div>
      </td>

      {}
      <td style={{
        padding:"15px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <div style={{display:"flex", alignItems:"center", gap:5, color:C.textMid}}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75"/>
          </svg>
          <span style={{fontSize:13, fontFamily:"'DM Sans',sans-serif", fontWeight:500}}>{lead.pax}</span>
        </div>
      </td>

      {}
      <td style={{
        padding:"15px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <StatusBadge status={lead.status}/>
      </td>

      {}
      <td style={{
        padding:"15px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <span style={{
          fontSize:13.5, fontWeight:600,
          color: lead.amount === "—" ? C.textFaint : C.text,
          fontFamily:"'Playfair Display',serif",
        }}>{lead.amount}</span>
      </td>

      {}
      <td style={{
        padding:"15px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <AssigneeChip name={lead.assignee} initials={lead.assigneeInitials}/>
      </td>

      {}
      <td style={{
        padding:"15px 16px 15px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", gap:12}}>
          <span style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}>{lead.ago}</span>
          <button style={{
            width:28, height:28, borderRadius:7,
            border:`1px solid ${C.border}`, background:"transparent",
            display:"flex", alignItems:"center", justifyContent:"center",
            cursor:"pointer", color:C.textMuted, flexShrink:0,
            transition:"background 0.1s, border-color 0.1s",
          }}
            onMouseEnter={e=>{ e.currentTarget.style.background=C.navyDeep; e.currentTarget.style.color=C.white; e.currentTarget.style.borderColor=C.navyDeep; }}
            onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; e.currentTarget.style.color=C.textMuted; e.currentTarget.style.borderColor=C.border; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6"/>
            </svg>
          </button>
        </div>
      </td>
    </tr>
  );
}

function EmptyLeads() {
  return (
    <div style={{
      padding:"72px 40px", textAlign:"center",
      display:"flex", flexDirection:"column", alignItems:"center", gap:16,
    }}>
      <div style={{
        width:52, height:52, borderRadius:14,
        background:C.ivory, border:`1px solid ${C.border}`,
        display:"flex", alignItems:"center", justifyContent:"center",
        color:C.textFaint, marginBottom:4,
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
        </svg>
      </div>
      <div>
        <div style={{fontSize:16, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6}}>
          Henüz talep bulunmuyor.
        </div>
        <div style={{fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
          Bu filtre için kayıt yok. Yeni bir talep ekleyebilirsiniz.
        </div>
      </div>
      <button style={{
        display:"flex", alignItems:"center", gap:8,
        padding:"9px 18px", borderRadius:8, marginTop:4,
        border:`1.5px solid ${C.gold}`, background:C.goldPale,
        cursor:"pointer", color:C.gold,
        fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        Yeni Talep Ekle
      </button>
    </div>
  );
}

function LeadsPage({ onSelectLead }) {
  const [showNewLead, setShowNewLead] = useState(false);
  const [activeTab, setActiveTab] = useState("Tümü");
  const [activeSource, setActiveSource] = useState("Tümü");
  const [search, setSearch] = useState("");
  const { data:repoLeads, loading:leadsLoading, error:leadsError, reload:reloadLeads }
    = useRepo("lead", "getAll");

  const [sortField, setSortField] = useState("ago");

  const _allLeads = repoLeads ?? [];
  const filtered = _allLeads.filter(lead => {
    const tabMatch  = activeTab === "Tümü" || lead.status === activeTab;
    const srcMatch  = activeSource === "Tümü" || lead.source === activeSource;
    const srchMatch = search === "" ||
      lead.name.toLowerCase().includes(search.toLowerCase()) ||
      lead.tour.toLowerCase().includes(search.toLowerCase()) ||
      lead.id.toLowerCase().includes(search.toLowerCase());
    return tabMatch && srcMatch && srchMatch;
  });

  const counts = STATUS_TABS.reduce((acc, tab) => {
    acc[tab] = tab === "Tümü"
      ? _allLeads.length
      : _allLeads.filter(l => l.status === tab).length;
    return acc;
  }, {});

  return (
    <div style={{display:"flex", flexDirection:"column", gap:20}}>

      {}
      <div className="page-header" style={{
        background:C.white, border:`1px solid ${C.border}`,
        borderRadius:12, padding:"22px 26px",
        display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:20,
      }}>
        <div>
          <h1 style={{
            margin:0, fontSize:24, fontWeight:700, color:C.text,
            fontFamily:"'Playfair Display',serif", lineHeight:1.2, marginBottom:5,
          }}>Talepler</h1>
          <p style={{
            margin:0, fontSize:13.5, color:C.textMuted,
            fontFamily:"'DM Sans',sans-serif",
          }}>
            Tüm müşteri taleplerini tek ekrandan takip edin.
          </p>
        </div>

        <div className="page-header-actions" style={{display:"flex", alignItems:"center", gap:10, flexShrink:0}}>
          {}
          <div style={{position:"relative"}}>
            <span style={{
              position:"absolute", left:10, top:"50%", transform:"translateY(-50%)",
              color:C.textFaint, pointerEvents:"none",
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
              </svg>
            </span>
            <input
              type="text" value={search}
              onChange={e=>setSearch(e.target.value)}
              placeholder="İsim, tur veya talep ara…"
              style={{
                paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
                border:`1px solid ${C.border}`, borderRadius:8,
                background:C.ivory, fontSize:13, color:C.text,
                fontFamily:"'DM Sans',sans-serif", outline:"none",
                width:230, transition:"border-color 0.15s, box-shadow 0.15s",
              }}
              onFocus={e=>{ e.target.style.borderColor=C.gold; e.target.style.boxShadow=`0 0 0 3px ${C.gold}20`; }}
              onBlur={e=>{ e.target.style.borderColor=C.border; e.target.style.boxShadow="none"; }}
            />
          </div>

          {}
          <button style={{
            display:"flex", alignItems:"center", gap:7,
            padding:"9px 16px", borderRadius:8,
            border:"none", background:C.navy,
            cursor:"pointer", color:C.white,
            fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
            transition:"background 0.12s",
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.navyHover}
            onMouseLeave={e=>e.currentTarget.style.background=C.navy}
            onClick={()=>setShowNewLead(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Yeni Talep Ekle
          </button>
        </div>
      </div>
      {showNewLead ? (<NewLeadModal onClose={()=>setShowNewLead(false)} onSuccess={()=>{setShowNewLead(false); reloadLeads&&reloadLeads();}}/>) : null}

      {}
      <div style={{
        background:C.white, border:`1px solid ${C.border}`,
        borderRadius:12, padding:"0 20px",
        display:"flex", flexDirection:"column",
      }}>

        {}
        <div style={{
          display:"flex", alignItems:"center", gap:0,
          borderBottom:`1px solid ${C.borderLight}`,
          overflowX:"auto",
        }}>
          {STATUS_TABS.map(tab => {
            const on = activeTab === tab;
            const cnt = counts[tab];
            return (
              <button key={tab} onClick={()=>setActiveTab(tab)}
                style={{
                  padding:"14px 16px",
                  border:"none", borderBottom: on ? `2px solid ${C.gold}` : "2px solid transparent",
                  background:"transparent",
                  color: on ? C.gold : C.textMuted,
                  fontFamily:"'DM Sans',sans-serif", fontSize:13,
                  fontWeight: on ? 600 : 400,
                  cursor:"pointer", whiteSpace:"nowrap",
                  display:"flex", alignItems:"center", gap:6,
                  transition:"color 0.12s",
                  marginBottom:-1,
                }}>
                {tab}
                {cnt > 0 && (
                  <span style={{
                    minWidth:18, height:18, borderRadius:99, padding:"0 5px",
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:10.5, fontWeight:600, lineHeight:1,
                    background: on ? `${C.gold}22` : C.ivoryDark,
                    color: on ? C.gold : C.textFaint,
                  }}>{cnt}</span>
                )}
              </button>
            );
          })}
        </div>

        {}
        <div style={{
          display:"flex", alignItems:"center", gap:8,
          padding:"12px 0",
          overflowX:"auto",
        }}>
          <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginRight:4, flexShrink:0}}>Kaynak:</span>
          {SOURCE_FILTERS.map(src => {
            const on = activeSource === src;
            return (
              <button key={src} onClick={()=>setActiveSource(src)}
                style={{
                  padding:"4px 12px", borderRadius:99, cursor:"pointer",
                  border: on ? `1.5px solid ${C.navy}` : `1px solid ${C.border}`,
                  background: on ? C.navy : "transparent",
                  color: on ? C.white : C.textMid,
                  fontFamily:"'DM Sans',sans-serif", fontSize:12, fontWeight: on ? 500 : 400,
                  whiteSpace:"nowrap", transition:"all 0.12s",
                }}>
                {src}
              </button>
            );
          })}

          {}
          <div style={{marginLeft:"auto", flexShrink:0}}>
            <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
              {filtered.length} talep gösteriliyor
            </span>
          </div>
        </div>
      </div>

      {}
      <div style={{
        background:C.white, border:`1px solid ${C.border}`,
        borderRadius:12, overflow:"hidden",
      }}>
        {leadsLoading ? (
          <LoadingState label="Talepler yükleniyor…"/>
        ) : leadsError ? (
          <ErrorState message={leadsError} onRetry={reloadLeads}/>
        ) : filtered.length === 0 ? <EmptyLeads/> : (
          <>
          <table className="rsp-table" style={{width:"100%", borderCollapse:"collapse"}}>
            <thead>
              <tr style={{borderBottom:`1px solid ${C.border}`}}>
                {[
                  { label:"Misafir",     w:"auto" },
                  { label:"Kaynak",      w:120    },
                  { label:"Tur / Tarih", w:"auto" },
                  { label:"Kişi",        w:60     },
                  { label:"Durum",       w:170    },
                  { label:"Tutar",       w:110    },
                  { label:"Sorumlu",     w:160    },
                  { label:"Son İşlem",   w:130    },
                ].map(h => (
                  <th key={h.label} style={{
                    padding: h.label === "Misafir" ? "12px 16px 12px 20px" : "12px 12px",
                    textAlign:"left", width:h.w !== "auto" ? h.w : undefined,
                    fontSize:10.5, fontWeight:600, color:C.textFaint,
                    fontFamily:"'DM Sans',sans-serif",
                    textTransform:"uppercase", letterSpacing:"0.07em",
                    background:C.ivory,
                  }}>{h.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((lead, i) => (
                <LeadRow key={lead.id} lead={lead} isLast={i === filtered.length - 1} onSelect={onSelectLead}/>
              ))}
            </tbody>
          </table>
            <div className="rsp-cards"><MobileCardList items={filtered} renderCard={(lead) => {
              const sm = STATUS_META[lead.status]||{color:C.textMuted,bg:C.ivoryDark};
              const srcObj = DB.sources.find(s=>s.id===lead.sourceId);
              const cust = getCustomerById(lead.customerId);
              return (
                <MobileCard onClick={()=>onSelectLead&&onSelectLead(lead.id)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:7}}>
                    <div>
                      <div style={{fontSize:14,fontWeight:600,color:C.text,fontFamily:"'DM Sans',sans-serif"}}>{lead.tour||"—"}</div>
                      <div style={{fontSize:12,color:C.textFaint,fontFamily:"'DM Sans',sans-serif"}}>{cust?.name||"—"}</div>
                    </div>
                    <span style={{fontSize:11,padding:"3px 9px",borderRadius:99,fontWeight:500,color:sm.color,background:sm.bg,fontFamily:"'DM Sans',sans-serif",flexShrink:0}}>{lead.status}</span>
                  </div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    <span style={{fontSize:12,color:C.textMuted,fontFamily:"'DM Sans',sans-serif"}}>{lead.paxAdult} kişi · {lead.dateRange||"Tarih yok"}</span>
                    <span style={{fontSize:12,color:C.textFaint,fontFamily:"'DM Sans',sans-serif"}}>{srcObj?.label||"—"} · {lead.ago}</span>
                  </div>
                </MobileCard>
              );
            }}/></div>
          </>
        )}

        {}
        {filtered.length > 0 && (
          <div style={{
            padding:"12px 20px",
            borderTop:`1px solid ${C.borderLight}`,
            display:"flex", alignItems:"center", justifyContent:"space-between",
            background:C.ivory,
          }}>
            <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
              {filtered.length} / {_allLeads.length} talep gösteriliyor
            </span>
            <div style={{display:"flex", alignItems:"center", gap:6}}>
              {[1].map(p=>(
                <button key={p} style={{
                  width:28, height:28, borderRadius:6,
                  border:`1px solid ${C.gold}`,
                  background:C.goldPale, color:C.gold,
                  fontSize:12, fontWeight:600, cursor:"pointer",
                  fontFamily:"'DM Sans',sans-serif",
                }}>1</button>
              ))}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

const LEAD_TIMELINE = [
  {
    date: "02 Haz",
    weekday: "Pazartesi",
    action: "Talep oluşturuldu",
    detail: "Booking.com üzerinden gelen talep sisteme eklendi.",
    type: "lead",
    time: "09:14",
    who: "Berk Çetinkaya",
  },
  {
    date: "03 Haz",
    weekday: "Salı",
    action: "Telefon görüşmesi yapıldı",
    detail: "Sarah Johnson ile 18 dakika görüşüldü. Tur detayları ve konaklama tercihleri paylaşıldı.",
    type: "call",
    time: "14:32",
    who: "Berk Çetinkaya",
  },
  {
    date: "04 Haz",
    weekday: "Çarşamba",
    action: "Teklif hazırlandı ve gönderildi",
    detail: "Private Istanbul Experience · 4 kişi · €3.600 tutarında teklif e-posta ile iletildi.",
    type: "quote",
    time: "11:05",
    who: "Berk Çetinkaya",
  },
  {
    date: "05 Haz",
    weekday: "Perşembe",
    action: "Müşteri dönüş yaptı",
    detail: "\"Boğaz turu seçeneği hakkında daha fazla bilgi alabilir miyiz?\" sorusu iletildi.",
    type: "reply",
    time: "16:48",
    who: "Sarah Johnson",
  },
  {
    date: "06 Haz",
    weekday: "Cuma",
    action: "Ödeme bekleniyor",
    detail: "€900 kapora ödemesi için son tarih 07 Haziran 2026 olarak belirlendi.",
    type: "payment",
    time: "09:30",
    who: "Berk Çetinkaya",
  },
];

const OPEN_TASKS = [
  { id:1, title:"Kapora ödemesini takip et", due:"07 Haz 2026", priority:"Acil" },
  { id:2, title:"Boğaz turu seçeneği hakkında bilgi gönder", due:"06 Haz 2026", priority:"Yüksek" },
];

const TIMELINE_TYPE_META = {
  lead:    { color: C.blue,   bg: C.blueBg,   icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
  call:    { color: "#4A5568", bg: "#F0EEF5",  icon: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.09-1.09a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" },
  quote:   { color: C.gold,   bg: C.goldPale, icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" },
  reply:   { color: C.green,  bg: C.greenBg,  icon: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" },
  payment: { color: C.amber,  bg: C.amberBg,  icon: "M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20" },
};

function DetailCard({ children, style }) {
  return (
    <div style={{
      background: C.white,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      overflow: "hidden",
      ...style,
    }}>
      {children}
    </div>
  );
}

function CardHeader({ title, action, onAction, accent }) {
  return (
    <div style={{
      padding: "14px 20px",
      borderBottom: `1px solid ${C.borderLight}`,
      background: accent ? C.navy : C.ivory,
      display: "flex", alignItems: "center", justifyContent: "space-between",
    }}>
      <span style={{
        fontSize: 11.5, fontWeight: 600, letterSpacing: "0.09em",
        textTransform: "uppercase", fontFamily: "'DM Sans',sans-serif",
        color: accent ? "rgba(248,245,238,0.7)" : C.textFaint,
      }}>{title}</span>
      {action && (
        <button onClick={onAction} style={{
          background: "none", border: "none", cursor: "pointer",
          fontSize: 12, color: accent ? C.goldLight : C.goldLight,
          fontFamily: "'DM Sans',sans-serif", fontWeight: 500,
          display: "flex", alignItems: "center", gap: 4, padding: 0,
        }}>{action}</button>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono, highlight }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "flex-start",
      padding: "10px 20px",
      borderBottom: `1px solid ${C.borderLight}`,
    }}>
      <span style={{
        fontSize: 12, color: C.textFaint,
        fontFamily: "'DM Sans',sans-serif", flexShrink: 0, paddingTop: 1,
        minWidth: 110,
      }}>{label}</span>
      <span style={{
        fontSize: 13, color: highlight ? C.gold : C.text,
        fontFamily: mono ? "'DM Mono',monospace" : "'DM Sans',sans-serif",
        fontWeight: highlight ? 600 : 400,
        textAlign: "right", wordBreak: "break-word",
      }}>{value}</span>
    </div>
  );
}

function IcD({ d, size = 16, sw = 1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color || "currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function CustomerCard({ lead }) {
  return (
    <DetailCard>
      {}
      <div style={{
        background: `linear-gradient(160deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
        padding: "24px 20px 20px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
      }}>
        {}
        <div style={{
          width: 64, height: 64, borderRadius: "50%",
          background: "rgba(201,168,76,0.18)",
          border: "2px solid rgba(201,168,76,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{
            fontSize: 22, fontWeight: 700, color: C.goldLight,
            fontFamily: "'Playfair Display',serif",
          }}>{lead.initials}</span>
        </div>
        {}
        <div style={{ textAlign: "center" }}>
          <div style={{
            fontSize: 18, fontWeight: 700, color: C.ivory,
            fontFamily: "'Playfair Display',serif", lineHeight: 1.2,
          }}>{lead.name}</div>
          <div style={{
            fontSize: 13, color: "rgba(248,245,238,0.6)",
            fontFamily: "'DM Sans',sans-serif", marginTop: 4,
          }}>{lead.flag} {lead.country} · {lead.language}</div>
        </div>
        {}
        <span style={{
          padding: "4px 12px", borderRadius: 99,
          background: "rgba(201,168,76,0.15)",
          border: "1px solid rgba(201,168,76,0.3)",
          fontSize: 11.5, color: C.goldLight,
          fontFamily: "'DM Sans',sans-serif", fontWeight: 500,
        }}>{lead.source}</span>
      </div>

      {}
      <InfoRow label="Telefon"       value={lead.phone}     mono />
      <InfoRow label="E-posta"       value={lead.email}     mono />
      <InfoRow label="Ülke"          value={`${lead.flag} ${lead.country}`} />
      <InfoRow label="Dil"           value={lead.language} />
      <InfoRow label="Kaynak"        value={lead.source} />
      <InfoRow label="Oluşturulma"   value={lead.createdAt} />
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        padding: "10px 20px",
      }}>
        <span style={{ fontSize: 12, color: C.textFaint, fontFamily: "'DM Sans',sans-serif", minWidth: 110 }}>Son Güncelleme</span>
        <span style={{ fontSize: 13, color: C.text, fontFamily: "'DM Sans',sans-serif" }}>{lead.updatedAt}</span>
      </div>

      {}
      {lead.notes && (
        <div style={{
          margin: "0 16px 16px",
          padding: "12px 14px",
          background: C.ivory, borderRadius: 8,
          border: `1px solid ${C.borderLight}`,
        }}>
          <div style={{
            fontSize: 10.5, color: C.textFaint, fontFamily: "'DM Sans',sans-serif",
            textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6,
          }}>Not</div>
          <div style={{
            fontSize: 12.5, color: C.textMid, fontFamily: "'DM Sans',sans-serif",
            lineHeight: 1.6,
          }}>{lead.notes}</div>
        </div>
      )}
    </DetailCard>
  );
}

function TravelCard({ lead }) {
  return (
    <DetailCard>
      <CardHeader title="Seyahat Talebi"/>
      <div style={{ padding: "20px" }}>
        {}
        <div style={{
          background: C.navy, borderRadius: 10, padding: "16px 18px", marginBottom: 16,
          display: "flex", alignItems: "flex-start", gap: 12,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8, flexShrink: 0,
            background: "rgba(201,168,76,0.18)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: C.goldLight,
          }}>
            <IcD d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10" size={16}/>
          </div>
          <div>
            <div style={{
              fontSize: 15, fontWeight: 700, color: C.ivory,
              fontFamily: "'Playfair Display',serif", lineHeight: 1.3,
            }}>{lead.tour}</div>
            <div style={{
              fontSize: 12, color: "rgba(248,245,238,0.55)",
              fontFamily: "'DM Sans',sans-serif", marginTop: 3,
            }}>{lead.dateRange}</div>
          </div>
        </div>

        {}
        {[
          { label: "Tarih Aralığı",      val: lead.dateRange,       icon: "M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z" },
          { label: "Kişi Sayısı",        val: `${lead.pax} Kişi`,   icon: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" },
          { label: "Karşılama",          val: lead.pickup,           icon: "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z" },
        ].map((r, i) => (
          <div key={i} style={{
            display: "flex", gap: 12, alignItems: "flex-start",
            padding: "11px 0",
            borderBottom: `1px solid ${C.borderLight}`,
          }}>
            <span style={{ color: C.textFaint, flexShrink: 0, marginTop: 1 }}>
              <IcD d={r.icon} size={14} sw={1.6}/>
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: C.textFaint, fontFamily: "'DM Sans',sans-serif", marginBottom: 2 }}>{r.label}</div>
              <div style={{ fontSize: 13, color: C.text, fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }}>{r.val}</div>
            </div>
          </div>
        ))}

        {}
        <div style={{ padding: "11px 0" }}>
          <div style={{ fontSize: 11, color: C.textFaint, fontFamily: "'DM Sans',sans-serif", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
            <IcD d="M12 20h9 M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" size={13} sw={1.6}/>
            Özel Talepler
          </div>
          <div style={{
            fontSize: 13, color: C.textMid, fontFamily: "'DM Sans',sans-serif",
            lineHeight: 1.65, background: C.ivory, borderRadius: 8,
            padding: "10px 12px", border: `1px solid ${C.borderLight}`,
          }}>{lead.specialRequests}</div>
        </div>
      </div>
    </DetailCard>
  );
}

function SalesCard({ lead }) {
  const sm = STATUS_META[lead.status] || { color: C.textMuted, bg: C.ivoryDark };
  return (
    <DetailCard>
      <CardHeader title="Satış Durumu"/>
      <div style={{ padding: "20px" }}>
        {}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderRadius: 10, marginBottom: 16,
          background: sm.bg, border: `1px solid ${sm.color}22`,
        }}>
          <div>
            <div style={{ fontSize: 11, color: C.textFaint, fontFamily: "'DM Sans',sans-serif", marginBottom: 4 }}>Güncel Durum</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: sm.color, fontFamily: "'DM Sans',sans-serif" }}>{lead.status}</div>
          </div>
          <div style={{
            width: 10, height: 10, borderRadius: "50%",
            background: sm.color, boxShadow: `0 0 0 3px ${sm.color}33`,
          }}/>
        </div>

        {}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          {[
            { label: "Teklif Tutarı", val: lead.quoteAmount, color: C.text },
            { label: "Kapora",        val: lead.deposit,      color: C.amber },
            { label: "Kalan",         val: lead.remaining,    color: C.red },
          ].map((a, i) => (
            <div key={i} style={{
              background: C.ivory, borderRadius: 8, padding: "12px 12px",
              border: `1px solid ${C.borderLight}`, textAlign: "center",
            }}>
              <div style={{ fontSize: 10.5, color: C.textFaint, fontFamily: "'DM Sans',sans-serif", marginBottom: 6 }}>{a.label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: a.color, fontFamily: "'Playfair Display',serif" }}>{a.val}</div>
            </div>
          ))}
        </div>

        {}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 11.5, color: C.textFaint, fontFamily: "'DM Sans',sans-serif" }}>Ödeme İlerlemesi</span>
            <span style={{ fontSize: 11.5, color: C.gold, fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>%25</span>
          </div>
          <div style={{ height: 6, background: C.ivoryDark, borderRadius: 99, overflow: "hidden" }}>
            <div style={{ width: "25%", height: "100%", background: C.gold, borderRadius: 99 }}/>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
            <span style={{ fontSize: 11, color: C.textFaint, fontFamily: "'DM Sans',sans-serif" }}>€900 ödendi</span>
            <span style={{ fontSize: 11, color: C.textFaint, fontFamily: "'DM Sans',sans-serif" }}>€2.700 kaldı</span>
          </div>
        </div>
      </div>
    </DetailCard>
  );
}

function TimelineCard() {
  return (
    <DetailCard>
      <CardHeader title="Aktivite Zaman Çizelgesi" action="Tümünü Gör"/>
      <div style={{ padding: "20px 20px 8px", position: "relative" }}>
        {}
        <div style={{
          position: "absolute", left: 38, top: 28, bottom: 16,
          width: 1, background: C.borderLight,
        }}/>

        {LEAD_TIMELINE.map((item, i) => {
          const m = TIMELINE_TYPE_META[item.type] || TIMELINE_TYPE_META.lead;
          const isLast = i === LEAD_TIMELINE.length - 1;
          return (
            <div key={i} style={{
              display: "flex", gap: 16, alignItems: "flex-start",
              paddingBottom: isLast ? 4 : 22,
            }}>
              {}
              <div style={{ width: 36, flexShrink: 0, textAlign: "center" }}>
                <div style={{
                  width: 32, height: 32, borderRadius: "50%",
                  background: m.bg, border: `1.5px solid ${m.color}40`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: m.color, position: "relative", zIndex: 1,
                  margin: "0 auto",
                }}>
                  <IcD d={m.icon} size={13} sw={1.7}/>
                </div>
              </div>

              {}
              <div style={{ flex: 1, paddingTop: 3 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, color: m.color,
                    fontFamily: "'DM Sans',sans-serif",
                    background: m.bg, padding: "1px 7px", borderRadius: 4,
                  }}>{item.date}</span>
                  <span style={{
                    fontSize: 13, fontWeight: 600, color: C.text,
                    fontFamily: "'DM Sans',sans-serif",
                  }}>{item.action}</span>
                  <span style={{
                    fontSize: 11, color: C.textFaint,
                    fontFamily: "'DM Sans',sans-serif", marginLeft: "auto",
                  }}>{item.time}</span>
                </div>
                <div style={{
                  fontSize: 12.5, color: C.textMuted,
                  fontFamily: "'DM Sans',sans-serif", lineHeight: 1.6,
                }}>{item.detail}</div>
                <div style={{
                  fontSize: 11, color: C.textFaint,
                  fontFamily: "'DM Sans',sans-serif", marginTop: 4,
                }}>— {item.who}</div>
              </div>
            </div>
          );
        })}
      </div>
    </DetailCard>
  );
}

const QUICK_ACTIONS = [
  { label: "Teklif Hazırla",      icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6", primary: true },
  { label: "Not Ekle",            icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
  { label: "Görev Oluştur",       icon: "M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
  { label: "Hatırlatma Oluştur",  icon: "M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" },
  { label: "WhatsApp Gönder",     icon: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z", whatsapp: true },
  { label: "Ödeme Kaydı Ekle",    icon: "M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20" },
];

function QuickActionsCard({ lead, navigate }) {
  const [hov, setHov] = useState(false);
  function handleTeklif() {
    if (lead) {
      const cust = getCustomerById(lead.customerId);
      SESSION.setPrefill({
        fromLead:      lead.id,
        guestName:     cust?.name || "",
        nationality:   cust?.country || "",
        email:         cust?.email || "",
        phone:         cust?.phone || "",
        tourName:      lead.tour || "",
        tourDate:      lead.dateRange || "",
        guestCount:    lead.paxAdult || 2,
        proposalNo:    "Q-2026-" + String(DB.quotes.length + 1).padStart(3,"0"),
      });
    }
    if (navigate) navigate("/quotes/new");
    else if (NAV_REF.fn) NAV_REF.fn("/quotes/new");
    else window.location.hash = "#/quotes/new";
  }

  return (
    <DetailCard>
      <CardHeader title="Hızlı İşlemler" accent/>
      <div style={{ padding: "14px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {QUICK_ACTIONS.map((a, i) => {
            const isPrimary = a.primary;
            const isWA = a.whatsapp;
            return (
              <button key={i}
                onMouseEnter={() => setHov(true)}
                onMouseLeave={() => setHov(false)}
                onClick={isPrimary ? handleTeklif : undefined}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", padding: "10px 14px", borderRadius: 8,
                  border: isPrimary ? "none" : `1px solid ${isWA ? "#128C7E44" : C.border}`,
                  background: isPrimary
                    ? (hov ? C.navyHover : C.navy)
                    : isWA
                      ? (hov ? "#E7F5F3" : "#F2FAF8")
                      : (hov ? C.ivory : C.white),
                  cursor: "pointer",
                  color: isPrimary ? C.white : isWA ? "#128C7E" : C.text,
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: 13, fontWeight: isPrimary ? 600 : 400,
                  transition: "background 0.12s, border-color 0.12s",
                  textAlign: "left",
                }}>
                <span style={{ flexShrink: 0, opacity: isPrimary ? 1 : 0.8 }}>
                  <IcD d={a.icon} size={15} sw={isPrimary ? 2 : 1.6} color="currentColor"/>
                </span>
                {a.label}
              </button>
            );
          })}
        </div>
      </div>
    </DetailCard>
  );
}

function NextActionCard({ lead }) {
  return (
    <DetailCard>
      <CardHeader title="Sonraki Aksiyon"/>
      <div style={{ padding: "18px 20px" }}>
        <div style={{
          background: C.amberBg, borderRadius: 10, padding: "14px 16px",
          border: `1px solid ${C.amber}22`, marginBottom: 14,
          display: "flex", gap: 12, alignItems: "flex-start",
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8, flexShrink: 0,
            background: "rgba(180,83,9,0.12)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: C.amber,
          }}>
            <IcD d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" size={16} sw={1.7}/>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.amber, fontFamily: "'DM Sans',sans-serif", marginBottom: 4 }}>
              {lead.nextAction}
            </div>
            <div style={{ fontSize: 12, color: C.textMuted, fontFamily: "'DM Sans',sans-serif", lineHeight: 1.5 }}>
              Kapora ödemesi bekleniyor. Müşteri ile iletişime geçilmeli.
            </div>
          </div>
        </div>

        {[
          { label: "Son Tarih", val: lead.nextDeadline, urgent: true },
          { label: "Sorumlu",   val: lead.assignee },
        ].map((r, i) => (
          <div key={i} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "9px 0",
            borderBottom: i === 0 ? `1px solid ${C.borderLight}` : "none",
          }}>
            <span style={{ fontSize: 12, color: C.textFaint, fontFamily: "'DM Sans',sans-serif" }}>{r.label}</span>
            <span style={{
              fontSize: 13, fontWeight: 500,
              color: r.urgent ? C.red : C.text,
              fontFamily: "'DM Sans',sans-serif",
            }}>{r.val}</span>
          </div>
        ))}
      </div>
    </DetailCard>
  );
}

function ActivitySummaryCard({ lead }) {
  const stats = [
    { label: "Son İletişim",         val: lead.lastContact },
    { label: "Toplam Teklif",        val: lead.totalQuotes },
    { label: "Toplam Rezervasyon",   val: lead.totalReservations },
    { label: "Açık Görevler",        val: lead.openTasks, alert: lead.openTasks > 0 },
  ];
  return (
    <DetailCard>
      <CardHeader title="Özet"/>
      <div style={{ padding: "6px 0" }}>
        {stats.map((s, i) => (
          <div key={i} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "11px 20px",
            borderBottom: i < stats.length - 1 ? `1px solid ${C.borderLight}` : "none",
          }}>
            <span style={{ fontSize: 12.5, color: C.textMuted, fontFamily: "'DM Sans',sans-serif" }}>{s.label}</span>
            <span style={{
              fontSize: 13.5, fontWeight: 600,
              color: s.alert ? C.red : C.text,
              fontFamily: "'Playfair Display',serif",
            }}>{s.val}</span>
          </div>
        ))}
      </div>
    </DetailCard>
  );
}

function OpenTasksCard() {
  return (
    <DetailCard>
      <CardHeader title="Açık Görevler" action="Tümü"/>
      <div style={{ padding: "4px 0 8px" }}>
        {OPEN_TASKS.map((t, i) => (
          <div key={t.id} style={{
            padding: "11px 20px",
            borderBottom: i < OPEN_TASKS.length - 1 ? `1px solid ${C.borderLight}` : "none",
            display: "flex", alignItems: "flex-start", gap: 10,
          }}>
            <div style={{
              width: 16, height: 16, borderRadius: 4, flexShrink: 0, marginTop: 2,
              border: `1.5px solid ${C.border}`, background: C.white, cursor: "pointer",
            }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: C.text, fontFamily: "'DM Sans',sans-serif", lineHeight: 1.4 }}>{t.title}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span style={{
                  fontSize: 10.5, fontWeight: 500,
                  color: t.priority === "Acil" ? C.red : C.amber,
                  background: t.priority === "Acil" ? C.redBg : C.amberBg,
                  padding: "1px 6px", borderRadius: 4,
                  fontFamily: "'DM Sans',sans-serif",
                }}>{t.priority}</span>
                <span style={{ fontSize: 11, color: C.textFaint, fontFamily: "'DM Sans',sans-serif" }}>{t.due}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </DetailCard>
  );
}

function LeadDetailPage({ onBack, leadId }) {
  const _sp = safeParam(leadId);
  if (_sp.invalid) return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:60,gap:16}}>
      <div style={{fontSize:36}}>🔍</div>
      <div style={{fontSize:16,fontWeight:600,color:'#1B2D4F',fontFamily:"'Playfair Display',serif"}}>Kayıt bulunamadı</div>
      <div style={{fontSize:13,color:'#6B7280'}}>
        {_sp.reason==='demo' ? 'Bu demo kayıt Supabase modunda görüntülenemez.' : 'Geçersiz kayıt kimliği.'}
      </div>
      <button onClick={onBack} style={{padding:'9px 20px',borderRadius:8,border:'none',background:'#1B2D4F',color:'#fff',cursor:'pointer',fontSize:13}}>Geri Dön</button>
    </div>
  );

  const { data:lead, loading:leadLoading, error:leadError }
    = useRepo("lead", "getById", leadId || (DB.leads[0]?.id ?? null));
  if (leadLoading) return <LoadingState label="Talep yükleniyor…"/>;
  if (leadError)   return <ErrorState message={leadError} onRetry={()=>{}}/>;
  if (!lead)       return <NotFoundCard entityType="Talep" entityId={leadId} onBack={onBack}/>;
  const customer = lead ? getCustomerById(lead.customerId) : null;
  const sm = STATUS_META[lead?.status] || { color: C.textMuted, bg: C.ivoryDark };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

      {}
      <div style={{
        background: C.white, border: `1px solid ${C.border}`, borderRadius: 12,
        padding: "16px 22px", marginBottom: 20,
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
      }}>
        {}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button onClick={onBack} style={{
            display: "flex", alignItems: "center", gap: 6,
            background: C.ivory, border: `1px solid ${C.border}`,
            borderRadius: 7, padding: "6px 12px", cursor: "pointer",
            color: C.textMid, fontFamily: "'DM Sans',sans-serif", fontSize: 12.5,
            transition: "background 0.1s",
          }}
            onMouseEnter={e => e.currentTarget.style.background = C.ivoryDark}
            onMouseLeave={e => e.currentTarget.style.background = C.ivory}
          >
            <IcD d="M15 18l-6-6 6-6" size={13} sw={2}/>
            Talepler
          </button>

          <div style={{ width: 1, height: 20, background: C.borderLight }}/>

          {}
          <span style={{
            fontSize: 12, color: C.textFaint, fontFamily: "'DM Mono',monospace",
            background: C.ivory, border: `1px solid ${C.borderLight}`,
            padding: "3px 8px", borderRadius: 5,
          }}>{lead.id}</span>
          {lead?.customerId && <IDLink id={lead.customerId} type="customer"/>}

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%",
              background: C.navyDeep,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.goldLight, fontFamily: "'Playfair Display',serif" }}>{lead.initials}</span>
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontFamily: "'Playfair Display',serif", lineHeight: 1.2 }}>
                {lead.name}
              </div>
              <div style={{ fontSize: 12, color: C.textFaint, fontFamily: "'DM Sans',sans-serif" }}>
                {lead.flag} {lead.country} · {lead.source}
              </div>
            </div>
          </div>
        </div>

        {}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 26, height: 26, borderRadius: "50%",
              background: "rgba(27,45,79,0.09)", border: "1.5px solid rgba(27,45,79,0.14)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: C.navy, fontFamily: "'DM Sans',sans-serif" }}>{lead.assigneeInitials}</span>
            </div>
            <span style={{ fontSize: 12.5, color: C.textMid, fontFamily: "'DM Sans',sans-serif" }}>{lead.assignee}</span>
          </div>

          <div style={{ width: 1, height: 20, background: C.borderLight }}/>

          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "5px 12px", borderRadius: 99,
            background: sm.bg, color: sm.color,
            fontSize: 12, fontWeight: 500,
            fontFamily: "'DM Sans',sans-serif",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: sm.color }}/>
            {lead.status}
          </span>

          {}
          <button style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "7px 14px", borderRadius: 7,
            border: `1.5px solid ${C.gold}`, background: C.goldPale,
            cursor: "pointer", color: C.gold,
            fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, fontWeight: 500,
          }}>
            <IcD d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" size={13} sw={1.8}/>
            Durumu Güncelle
          </button>
        </div>
      </div>

      {}
      <div className="rsp-split" style={{
        display: "grid",
        gridTemplateColumns: "260px 1fr 268px",
        gap: 18,
        alignItems: "start",
      }}>
        {}
        <CustomerCard lead={lead}/>

        {}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <TravelCard lead={lead}/>
          <SalesCard lead={lead}/>
          <TimelineCard/>
        </div>

        {}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <QuickActionsCard lead={lead}/>
          <NextActionCard lead={lead}/>
          <ActivitySummaryCard lead={lead}/>
          <OpenTasksCard/>
        </div>
      </div>
    </div>
  );
}

const QUOTE_STATUS = {
  "Taslak":        { color:"#6B3FA0", bg:"#F3EEF9" },
  "Gönderildi":    { color:"#B8973A", bg:"#F5EDD4" },
  "Görüldü":       { color:"#1A6FAE", bg:"#E8F2FB" },
  "Onaylandı":     { color:"#2E7D52", bg:"#EBF5EF" },
  "Reddedildi":    { color:"#C0392B", bg:"#FDECEC" },
  "Süresi Doldu":  { color:"#8A8070", bg:"#F3F1ED" },
};

const TOUR_CATALOG = DB.tours
  .filter(t => t.status === "Aktif" && t.tiers)
  .map(t => ({
    id: t.id, name: t.name,
    basePrice: t.basePrice, currency: t.currency,
    tiers: t.tiers,
    included: t.included, excluded: t.excluded,
  })); // derived from DB.tours

const MOCK_QUOTES = DB.quotes; // → centralized DB

function QIc({ d, size=16, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function QStatusBadge({ status }) {
  const m = QUOTE_STATUS[status] || { color:C.textMuted, bg:C.ivoryDark };
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding:"4px 10px", borderRadius:99,
      background:m.bg, color:m.color,
      fontSize:11.5, fontWeight:500, fontFamily:"'DM Sans',sans-serif",
      whiteSpace:"nowrap",
    }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:m.color, flexShrink:0 }}/>
      {status}
    </span>
  );
}

function QuoteRow({ q, isLast, onSelect }) {
  const sm = QUOTE_STATUS[q.status] || {};
  const expired = q.status === "Süresi Doldu" || q.status === "Reddedildi";

  return (
    <tr
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      onClick={()=>onSelect&&onSelect(q.id)}
      style={{
        background:C.white,
        cursor:"pointer", transition:"background 0.1s",
        opacity: expired ? 0.7 : 1,
      }}
    >
      {}
      <td style={{ padding:"14px 16px 14px 22px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
        <span style={{
          fontSize:12.5, fontWeight:600, color:C.navy,
          fontFamily:"'DM Mono',monospace",
          background:C.ivory, border:`1px solid ${C.borderLight}`,
          padding:"3px 8px", borderRadius:5,
        }}>{q.id}</span>
      </td>
      {}
      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
        <div style={{ fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{q.flag} {q.customer}</div>
        <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{q.country}</div>
      </td>
      {}
      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle", maxWidth:200 }}>
        <div style={{ fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif", fontWeight:500 }}>{q.tour}</div>
        <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{q.dateRange}</div>
      </td>
      {}
      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
        <div style={{ display:"flex", alignItems:"center", gap:5, color:C.textMid }}>
          <QIc d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" size={13} sw={1.5}/>
          <span style={{ fontSize:13, fontFamily:"'DM Sans',sans-serif", fontWeight:500 }}>{q.pax}</span>
        </div>
      </td>
      {}
      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
        <div style={{ fontSize:15, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>
          {q.currency === "EUR" ? "€" : "₺"}{q.fmtNum(total)}
        </div>
        <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{q.currency}</div>
      </td>
      {}
      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
        <QStatusBadge status={q.status}/>
      </td>
      {}
      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
        <div style={{ fontSize:12.5, color: expired ? C.red : C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>{q.validUntil}</div>
      </td>
      {}
      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
        <div style={{ fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{q.createdAt}</div>
      </td>
      {}
      <td style={{ padding:"14px 16px 14px 8px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
        <div style={{ color:C.textFaint }}>
          <QIc d="M9 18l6-6-6-6" size={14} sw={1.8}/>
        </div>
      </td>
    </tr>
  );
}

function QuotesPage({ onSelectQuote, onNewQuote }) {
  const [activeTab, setActiveTab] = useState("Tümü");
  const [search, setSearch] = useState("");
  const { data:repoQuotes, loading:quotesLoading, error:quotesError, reload:reloadQuotes }
    = useRepo("quote", "getAll");

  const TABS = ["Tümü",...Object.keys(QUOTE_STATUS)];
  const allQuotes = repoQuotes ?? [];

  const filtered = allQuotes.filter(q => {
    const tabMatch  = activeTab === "Tümü" || q.status === activeTab;
    const srchMatch = search === "" ||
      q.customer.toLowerCase().includes(search.toLowerCase()) ||
      q.tour.toLowerCase().includes(search.toLowerCase()) ||
      q.id.toLowerCase().includes(search.toLowerCase());
    return tabMatch && srchMatch;
  });

  const counts = TABS.reduce((acc,t) => {
    acc[t] = t === "Tümü" ? allQuotes.length : allQuotes.filter(q=>q.status===t).length;
    return acc;
  }, {});

  const totalSent     = allQuotes.filter(q=>q.status==="Gönderildi").length;
  const totalApproved = allQuotes.filter(q=>q.status==="Onaylandı").length;
  const totalValue    = allQuotes.filter(q=>q.status==="Onaylandı").reduce((s,q)=>s+q.total,0);
  const convRate      = allQuotes.length > 0 ? Math.round((totalApproved/allQuotes.length)*100) : 0;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

      {}
      <div className="page-header" style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"22px 26px",
        display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:20,
      }}>
        <div>
          <h1 style={{ margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:5 }}>Teklifler</h1>
          <p style={{ margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>
            Tüm teklifleri yönetin ve satış sürecini takip edin.
          </p>
        </div>
        <div className="page-header-actions" style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          {}
          <div style={{ position:"relative" }}>
            <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.textFaint, pointerEvents:"none" }}>
              <QIc d="M21 21l-4.35-4.35 M17 11A6 6 0 105 11a6 6 0 0012 0z" size={14} sw={1.8}/>
            </span>
            <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Teklif, misafir veya tur ara…"
              style={{
                paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
                border:`1px solid ${C.border}`, borderRadius:8,
                background:C.ivory, fontSize:13, color:C.text,
                fontFamily:"'DM Sans',sans-serif", outline:"none", width:240,
                transition:"border-color 0.15s, box-shadow 0.15s",
              }}
              onFocus={e=>{ e.target.style.borderColor=C.gold; e.target.style.boxShadow=`0 0 0 3px ${C.gold}20`; }}
              onBlur={e=>{ e.target.style.borderColor=C.border; e.target.style.boxShadow="none"; }}
            />
          </div>
          <button style={{
            display:"flex", alignItems:"center", gap:7,
            padding:"9px 16px", borderRadius:8,
            border:"none", background:C.navy, cursor:"pointer", color:C.white,
            fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
            transition:"background 0.12s",
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.navyHover}
            onMouseLeave={e=>e.currentTarget.style.background=C.navy}
            onClick={onNewQuote}
          >
            <QIc d="M12 5v14M5 12h14" size={14} sw={2.5}/>
            Yeni Teklif Oluştur
          </button>
        </div>
      </div>

      {}
      <div className="rsp-stat-grid" style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14 }}>
        {[
          { label:"Toplam Teklif",    val:allQuotes.length, sub:"Tüm zamanlar", icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6" },
          { label:"Gönderildi",       val:totalSent,          sub:"Yanıt bekleniyor", icon:"M22 2L11 13 M22 2L15 22l-4-9-9-4 22-7z", alert:false },
          { label:"Onaylandı",        val:totalApproved,      sub:`€${totalValue} toplam değer`, icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", green:true },
          { label:"Dönüşüm Oranı",    val:`%${convRate}`,     sub:"Onaylanan / Toplam", icon:"M18 20V10M12 20V4M6 20v-6", gold:true },
        ].map((k,i) => (
          <div key={i} style={{
            background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
            padding:"18px 20px", display:"flex", alignItems:"flex-start", gap:14,
          }}>
            <div style={{
              width:40, height:40, borderRadius:10, flexShrink:0,
              background: k.green ? C.greenBg : k.gold ? C.goldPale : C.ivory,
              border:`1px solid ${C.borderLight}`,
              display:"flex", alignItems:"center", justifyContent:"center",
              color: k.green ? C.green : k.gold ? C.gold : C.textMuted,
            }}>
              <QIc d={k.icon} size={17} sw={1.6}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginBottom:4 }}>{k.label}</div>
              <div style={{ fontSize:24, fontWeight:700, color: k.green ? C.green : k.gold ? C.gold : C.text, fontFamily:"'Playfair Display',serif", lineHeight:1 }}>{k.val}</div>
              <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:4 }}>{k.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {}
      <div style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden" }}>
        {}
        <div style={{ display:"flex", alignItems:"center", borderBottom:`1px solid ${C.borderLight}`, padding:"0 20px", overflowX:"auto" }}>
          {TABS.map(tab => {
            const on = activeTab === tab;
            return (
              <button key={tab} onClick={()=>setActiveTab(tab)} style={{
                padding:"14px 14px",
                border:"none", borderBottom: on ? `2px solid ${C.gold}` : "2px solid transparent",
                background:"transparent",
                color: on ? C.gold : C.textMuted,
                fontFamily:"'DM Sans',sans-serif", fontSize:13,
                fontWeight: on ? 600 : 400,
                cursor:"pointer", whiteSpace:"nowrap",
                display:"flex", alignItems:"center", gap:6,
                marginBottom:-1, transition:"color 0.12s",
              }}>
                {tab}
                {counts[tab] > 0 && (
                  <span style={{
                    minWidth:18, height:18, borderRadius:99, padding:"0 5px",
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:10.5, fontWeight:600, lineHeight:1,
                    background: on ? `${C.gold}22` : C.ivoryDark,
                    color: on ? C.gold : C.textFaint,
                  }}>{counts[tab]}</span>
                )}
              </button>
            );
          })}
          <div style={{ marginLeft:"auto", padding:"0 4px", flexShrink:0 }}>
            <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{filtered.length} teklif</span>
          </div>
        </div>

        {}
        {quotesLoading ? (
          <LoadingState label="Teklifler yükleniyor…"/>
        ) : quotesError ? (
          <ErrorState message={quotesError} onRetry={reloadQuotes}/>
        ) : filtered.length === 0 ? (
          <div style={{ padding:"60px 40px", textAlign:"center" }}>
            <div style={{ fontSize:32, opacity:0.2, marginBottom:12 }}>📄</div>
            <div style={{ fontSize:15, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6 }}>Teklif bulunamadı.</div>
            <div style={{ fontSize:13, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>Bu filtre için kayıt yok.</div>
          </div>
        ) : (
          <>
            <table className="rsp-table" style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ borderBottom:`1px solid ${C.border}` }}>
                  {["Teklif No","Misafir","Tur / Tarih","Kişi","Tutar","Durum","Geçerlilik","Oluşturulma",""].map(h=>(
                    <th key={h} style={{
                      padding: h==="Teklif No" ? "12px 16px 12px 22px" : "12px 12px",
                      textAlign:"left",
                      fontSize:10.5, fontWeight:600, color:C.textFaint,
                      fontFamily:"'DM Sans',sans-serif",
                      textTransform:"uppercase", letterSpacing:"0.07em",
                      background:C.ivory,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((q,i)=>(
                  <QuoteRow key={q.id} q={q} isLast={i===filtered.length-1} onSelect={onSelectQuote}/>
                ))}
              </tbody>
            </table>
            <div className="rsp-cards"><MobileCardList items={filtered} renderCard={(item,i)=>(
                <MobileCard key={item.id} onClick={()=>onSelectQuote&&onSelectQuote(item.id)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontWeight:600,fontSize:14,color:C.text}}>{item.quoteNumber}</div>
                      <div style={{fontSize:12,color:C.textMuted,marginTop:2}}>{item.tour||"—"} · {item.currency} {fmtNum(item.total)}</div>
                    </div>
                    <span style={{fontSize:11,padding:"3px 8px",borderRadius:99,background:C.ivoryDark,color:C.textMid}}>{item.status}</span>
                  </div>
                </MobileCard>
              )}/></div>
            {}
            <div style={{
              padding:"11px 20px",
              borderTop:`1px solid ${C.borderLight}`,
              background:C.ivory,
              display:"flex", alignItems:"center", justifyContent:"space-between",
            }}>
              <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>
                {filtered.length} / {allQuotes.length} teklif gösteriliyor
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function QuoteBuilder() {
  const [selectedTourId, setSelectedTourId] = useState("T1");
  const [pax, setPax]                       = useState(4);
  const [currency, setCurrency]             = useState("EUR");
  const [discountPct, setDiscountPct]       = useState(0);
  const [depositPct, setDepositPct]         = useState(25);

  const tour       = TOUR_CATALOG.find(t=>t.id===selectedTourId);
  const maxPax     = 8;
  const baseTotal  = tour ? (tour.tiers[pax] || tour.tiers[maxPax]) : 0;
  const discount   = Math.round(baseTotal * discountPct / 100);
  const afterDisc  = baseTotal - discount;
  const deposit    = Math.round(afterDisc * depositPct / 100);
  const remaining  = afterDisc - deposit;

  const fmtC = (n) => `${currency === "EUR" ? "€" : "₺"}${n.toLocaleString()}`;
  const fmtUnit = () => `${currency === "EUR" ? "€" : "₺"}${Math.round(baseTotal/pax)}`;

  const DISC_OPTIONS = [0,5,10,15,20];
  const DEP_OPTIONS  = [20,25,30,50];

  return (
    <div style={{
      background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden",
    }}>
      {}
      <div style={{
        background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
        padding:"18px 22px",
        display:"flex", alignItems:"center", justifyContent:"space-between",
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{
            width:34, height:34, borderRadius:8,
            background:"rgba(201,168,76,0.15)", border:"1px solid rgba(201,168,76,0.3)",
            display:"flex", alignItems:"center", justifyContent:"center", color:C.goldLight,
          }}>
            <QIc d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 11h.01M12 11h.01M15 11h.01M9 7h6m0 10v-3m-3 3h.01" size={16} sw={1.8}/>
          </div>
          <div>
            <div style={{ fontSize:14, fontWeight:600, color:C.ivory, fontFamily:"'Playfair Display',serif" }}>Teklif Oluşturucu</div>
            <div style={{ fontSize:11.5, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Sans',sans-serif" }}>Fiyat otomatik hesaplanır</div>
          </div>
        </div>
        <div style={{
          background:"rgba(201,168,76,0.15)", border:"1px solid rgba(201,168,76,0.3)",
          borderRadius:8, padding:"8px 16px",
          display:"flex", alignItems:"baseline", gap:6,
        }}>
          <span style={{ fontSize:26, fontWeight:700, color:C.goldLight, fontFamily:"'Playfair Display',serif" }}>{fmtC(afterDisc)}</span>
          <span style={{ fontSize:12, color:"rgba(201,168,76,0.65)", fontFamily:"'DM Sans',sans-serif" }}>{currency} · {pax} kişi</span>
        </div>
      </div>

      <div style={{ padding:"22px", display:"grid", gridTemplateColumns:"1fr 1fr", gap:22 }}>
        {}
        <div style={{ display:"flex", flexDirection:"column", gap:18 }}>

          {}
          <div>
            <label style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", display:"block", marginBottom:8 }}>Tur Seçin</label>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {TOUR_CATALOG.map(t => {
                const on = t.id === selectedTourId;
                return (
                  <button key={t.id} onClick={()=>setSelectedTourId(t.id)} style={{
                    display:"flex", alignItems:"center", justifyContent:"space-between",
                    padding:"10px 14px", borderRadius:8, cursor:"pointer",
                    border: on ? `1.5px solid ${C.gold}` : `1px solid ${C.border}`,
                    background: on ? C.goldPale : C.white,
                    transition:"all 0.12s",
                  }}>
                    <span style={{ fontSize:13, fontWeight: on ? 600 : 400, color: on ? C.gold : C.text, fontFamily:"'DM Sans',sans-serif" }}>{t.name}</span>
                    <span style={{ fontSize:12, color: on ? C.gold : C.textFaint, fontFamily:"'DM Mono',monospace" }}>
                      {currency==="EUR"?"€":"₺"}{t.tiers[1]}/kişi
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {}
          <div>
            <label style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", display:"block", marginBottom:8 }}>
              Kişi Sayısı — <span style={{ color:C.text, fontWeight:600 }}>{pax} kişi</span>
            </label>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {[1,2,3,4,5,6,7,8].map(n => (
                <button key={n} onClick={()=>setPax(n)} style={{
                  width:40, height:36, borderRadius:7, cursor:"pointer",
                  border: n===pax ? `1.5px solid ${C.gold}` : `1px solid ${C.border}`,
                  background: n===pax ? C.goldPale : C.white,
                  color: n===pax ? C.gold : C.textMid,
                  fontSize:13.5, fontWeight: n===pax ? 700 : 400,
                  fontFamily:"'DM Sans',sans-serif",
                  transition:"all 0.12s",
                }}>{n}</button>
              ))}
            </div>
          </div>

          {}
          <div>
            <label style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", display:"block", marginBottom:8 }}>Para Birimi</label>
            <div style={{ display:"flex", gap:8 }}>
              {["EUR","TRY","USD"].map(cur=>(
                <button key={cur} onClick={()=>setCurrency(cur)} style={{
                  padding:"7px 16px", borderRadius:7, cursor:"pointer",
                  border: cur===currency ? `1.5px solid ${C.gold}` : `1px solid ${C.border}`,
                  background: cur===currency ? C.goldPale : C.white,
                  color: cur===currency ? C.gold : C.textMid,
                  fontSize:13, fontWeight: cur===currency ? 600 : 400,
                  fontFamily:"'DM Sans',sans-serif",
                  transition:"all 0.12s",
                }}>{cur}</button>
              ))}
            </div>
          </div>

          {}
          <div>
            <label style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", display:"block", marginBottom:8 }}>
              İndirim — <span style={{ color:C.text, fontWeight:600 }}>%{discountPct}</span>
              {discount > 0 && <span style={{ color:C.red, marginLeft:6 }}>(-{fmtC(discount)})</span>}
            </label>
            <div style={{ display:"flex", gap:6 }}>
              {DISC_OPTIONS.map(d=>(
                <button key={d} onClick={()=>setDiscountPct(d)} style={{
                  padding:"7px 12px", borderRadius:7, cursor:"pointer",
                  border: d===discountPct ? `1.5px solid ${C.red}` : `1px solid ${C.border}`,
                  background: d===discountPct ? "#FDECEC" : C.white,
                  color: d===discountPct ? C.red : C.textMid,
                  fontSize:12.5, fontWeight: d===discountPct ? 600 : 400,
                  fontFamily:"'DM Sans',sans-serif",
                  transition:"all 0.12s",
                }}>%{d}</button>
              ))}
            </div>
          </div>

          {}
          <div>
            <label style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", display:"block", marginBottom:8 }}>
              Kapora Oranı — <span style={{ color:C.text, fontWeight:600 }}>%{depositPct}</span>
            </label>
            <div style={{ display:"flex", gap:6 }}>
              {DEP_OPTIONS.map(d=>(
                <button key={d} onClick={()=>setDepositPct(d)} style={{
                  padding:"7px 12px", borderRadius:7, cursor:"pointer",
                  border: d===depositPct ? `1.5px solid ${C.amber}` : `1px solid ${C.border}`,
                  background: d===depositPct ? C.amberBg : C.white,
                  color: d===depositPct ? C.amber : C.textMid,
                  fontSize:12.5, fontWeight: d===depositPct ? 600 : 400,
                  fontFamily:"'DM Sans',sans-serif",
                  transition:"all 0.12s",
                }}>%{d}</button>
              ))}
            </div>
          </div>
        </div>

        {}
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>

          {}
          <div style={{ background:C.ivory, borderRadius:10, border:`1px solid ${C.borderLight}`, overflow:"hidden" }}>
            <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`, background:C.navy }}>
              <span style={{ fontSize:11, fontWeight:600, color:"rgba(248,245,238,0.6)", fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em" }}>Fiyat Özeti</span>
            </div>
            {[
              { label:`Kişi Başı Fiyat`, val:fmtUnit(), sub:null },
              { label:`Kişi Sayısı`, val:`× ${pax}`, sub:null },
              { label:`Ara Toplam`, val:fmtC(baseTotal), bold:true },
              ...(discount > 0 ? [{ label:`İndirim (%${discountPct})`, val:`-${fmtC(discount)}`, red:true }] : []),
              { label:`Toplam`, val:fmtC(afterDisc), bold:true, gold:true, large:true },
              { label:`Kapora (%${depositPct})`, val:fmtC(deposit), amber:true },
              { label:`Kalan Ödeme`, val:fmtC(remaining), muted:true },
            ].map((r,i,arr)=>(
              <div key={i} style={{
                display:"flex", justifyContent:"space-between", alignItems:"center",
                padding: r.large ? "14px 16px" : "10px 16px",
                borderBottom: i<arr.length-1 ? `1px solid ${C.borderLight}` : "none",
                background: r.gold ? C.goldPale : r.large ? C.ivory : "transparent",
              }}>
                <span style={{
                  fontSize: r.large ? 13 : 12,
                  color:C.textMuted, fontFamily:"'DM Sans',sans-serif",
                }}>{r.label}</span>
                <span style={{
                  fontSize: r.large ? 20 : 14,
                  fontWeight: r.large || r.bold ? 700 : 500,
                  color: r.gold ? C.gold : r.red ? C.red : r.amber ? C.amber : r.muted ? C.textMuted : C.text,
                  fontFamily:"'Playfair Display',serif",
                }}>{r.val}</span>
              </div>
            ))}
          </div>

          {}
          <div style={{ background:C.ivory, borderRadius:10, border:`1px solid ${C.borderLight}`, overflow:"hidden" }}>
            <div style={{ padding:"10px 16px", borderBottom:`1px solid ${C.borderLight}`, background:C.white }}>
              <span style={{ fontSize:11, fontWeight:600, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em" }}>Kişi Başına Fiyat Skalası</span>
            </div>
            {Object.entries(tour?.tiers||{}).map(([n,p],i,arr)=>{
              const on = parseInt(n)===pax;
              return (
                <div key={n} onClick={()=>setPax(parseInt(n))} style={{
                  display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"9px 16px", cursor:"pointer",
                  borderBottom: i<arr.length-1 ? `1px solid ${C.borderLight}` : "none",
                  background: on ? C.goldPale : "transparent",
                  transition:"background 0.1s",
                }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    {on && <span style={{ width:6, height:6, borderRadius:"50%", background:C.gold, flexShrink:0 }}/>}
                    <span style={{ fontSize:12.5, color: on ? C.gold : C.textMid, fontFamily:"'DM Sans',sans-serif", fontWeight: on ? 600 : 400 }}>{n} kişi</span>
                  </div>
                  <span style={{ fontSize:13, fontWeight: on ? 700 : 500, color: on ? C.gold : C.text, fontFamily:"'Playfair Display',serif" }}>
                    {currency==="EUR"?"€":"₺"}{p}
                  </span>
                </div>
              );
            })}
          </div>

          {}
          <button style={{
            padding:"12px", borderRadius:8, cursor:"pointer",
            background:C.navy, border:"none", color:C.white,
            fontFamily:"'DM Sans',sans-serif", fontSize:13.5, fontWeight:600,
            display:"flex", alignItems:"center", justifyContent:"center", gap:8,
            transition:"background 0.12s",
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.navyHover}
            onMouseLeave={e=>e.currentTarget.style.background=C.navy}
          >
            <QIc d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6" size={15} sw={2}/>
            Bu Fiyatla Teklif Oluştur
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckItem({ label, checked }) {
  const [on, setOn] = useState(checked !== false);
  return (
    <div
      onClick={()=>setOn(p=>!p)}
      style={{
        display:"flex", alignItems:"center", gap:10,
        padding:"8px 0", cursor:"pointer",
        borderBottom:`1px solid ${C.borderLight}`,
      }}
    >
      <div style={{
        width:18, height:18, borderRadius:4, flexShrink:0,
        border: on ? `none` : `1.5px solid ${C.border}`,
        background: on ? C.green : C.white,
        display:"flex", alignItems:"center", justifyContent:"center",
        transition:"background 0.15s",
      }}>
        {on && <QIc d="M20 6L9 17l-5-5" size={11} sw={2.5} color="#fff"/>}
      </div>
      <span style={{
        fontSize:13, color: on ? C.text : C.textMuted,
        fontFamily:"'DM Sans',sans-serif",
        textDecoration: on ? "none" : "line-through",
      }}>{label}</span>
    </div>
  );
}

function QCard({ children, style }) {
  return (
    <div style={{
      background:C.white, border:`1px solid ${C.border}`,
      borderRadius:12, overflow:"hidden", ...style,
    }}>{children}</div>
  );
}

function QCardHead({ title, badge }) {
  return (
    <div style={{
      padding:"13px 20px", background:C.ivory,
      borderBottom:`1px solid ${C.borderLight}`,
      display:"flex", alignItems:"center", gap:10,
    }}>
      <span style={{ fontSize:11, fontWeight:600, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.09em", flex:1 }}>{title}</span>
      {badge}
    </div>
  );
}

function QInfoRow({ label, value, mono, bold, gold, red }) {
  return (
    <div style={{
      display:"flex", justifyContent:"space-between", alignItems:"flex-start",
      padding:"10px 20px", borderBottom:`1px solid ${C.borderLight}`,
    }}>
      <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", flexShrink:0, minWidth:110, paddingTop:1 }}>{label}</span>
      <span style={{
        fontSize: bold ? 15 : 13,
        color: gold ? C.gold : red ? C.red : C.text,
        fontFamily: mono ? "'DM Mono',monospace" : bold ? "'Playfair Display',serif" : "'DM Sans',sans-serif",
        fontWeight: bold ? 700 : 400,
        textAlign:"right",
      }}>{value}</span>
    </div>
  );
}

function QuoteDetailPage({ quoteId, onBack }) {
  const _sp = safeParam(quoteId);
  if (_sp.invalid) return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:60,gap:16}}>
      <div style={{fontSize:36}}>🔍</div>
      <div style={{fontSize:16,fontWeight:600,color:'#1B2D4F',fontFamily:"'Playfair Display',serif"}}>Kayıt bulunamadı</div>
      <div style={{fontSize:13,color:'#6B7280'}}>
        {_sp.reason==='demo' ? 'Bu demo kayıt Supabase modunda görüntülenemez.' : 'Geçersiz kayıt kimliği.'}
      </div>
      <button onClick={onBack} style={{padding:'9px 20px',borderRadius:8,border:'none',background:'#1B2D4F',color:'#fff',cursor:'pointer',fontSize:13}}>Geri Dön</button>
    </div>
  );

  const { data:q, loading:qLoading, error:qError } = useRepo("quote", "getById", quoteId);
  const { mutate:mutQuote, mutating:quoteMut }      = useRepoMutation("quote");

  const [convertBusy,  setConvertBusy]  = useState(false);
  const [convertDone,  setConvertDone]  = useState(false);
  const [showPreview,  setShowPreview]  = useState(false);
  const [proposalSent, setProposalSent] = useState(false);

  if (qLoading) return <LoadingState label="Teklif yükleniyor…"/>;
  if (qError)   return <ErrorState message={qError} onRetry={()=>{}}/>;
  if (!q)       return (
    <div style={{padding:40,textAlign:"center"}}>
      <NotFound404 onBack={onBack}/>
    </div>
  );
  const sm = QUOTE_STATUS[q.status] || {};
  const tour = TOUR_CATALOG.find(t=>t.name===q.tour) || TOUR_CATALOG[0];
  const sym = q.currency === "EUR" ? "€" : "₺";
  const fmtQ = (n) => `${sym}${n.toLocaleString()}`;

  const ACTIONS = [
    { label:"WhatsApp Teklifi Oluştur", icon:"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967c-.273-.099-.471-.148-.67.15c-.197.297-.767.966-.94 1.164c-.173.199-.347.223-.644.075c-.297-.15-1.255-.463-2.39-1.475c-.883-.788-1.48-1.761-1.653-2.059c-.173-.297-.018-.458.13-.606c.134-.133.298-.347.446-.52c.149-.174.198-.298.298-.497c.099-.198.05-.371-.025-.52c-.075-.149-.669-1.612-.916-2.207c-.242-.579-.487-.5-.669-.51c-.173-.008-.371-.01-.57-.01c-.198 0-.52.074-.792.372c-.272.297-1.04 1.016-1.04 2.479c0 1.462 1.065 2.875 1.213 3.074c.149.198 2.096 3.2 5.077 4.487c.709.306 1.262.489 1.694.625c.712.227 1.36.195 1.871.118c.571-.085 1.758-.719 2.006-1.413c.248-.694.248-1.289.173-1.413c-.074-.124-.272-.198-.57-.347z", wa:true },
    { label:"Email Teklifi Oluştur",    icon:"M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6" },
    { label:"PDF Önizleme",             icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" },
    { label:"Rezervasyona Dönüştür",    icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", primary:true },
    { label:"Kopyala",                  icon:"M8 17.929H6c-1.105 0-2-.912-2-2.036V5.036C4 3.91 4.895 3 6 3h8c1.105 0 2 .911 2 2.036v1.866m-6 .17h8c1.105 0 2 .91 2 2.035v10.857C20 21.09 19.105 22 18 22h-8c-1.105 0-2-.911-2-2.036V9.107c0-1.124.895-2.036 2-2.036z" },
    { label:"Düzenle",                  icon:"M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
    { label:"Onaylandı Olarak İşaretle",icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", primary:true },
  ];

  const proposalData = q ? buildProposalData(q, getCustomerById(q.customerId)) : null;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20, position:"relative" }}>
      {showPreview ? (proposalData && (
        <ProposalPreviewModal
          data={proposalData}
          quoteNumber={q.quoteNumber||q.id}
          onClose={()=>setShowPreview(false)}
          onSend={()=>{ setProposalSent(true); setShowPreview(false); }}
        />
      )) : null}

      {}
      <div style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"15px 22px",
        display:"flex", alignItems:"center", justifyContent:"space-between", gap:16,
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <button onClick={onBack} style={{
            display:"flex", alignItems:"center", gap:6,
            background:C.ivory, border:`1px solid ${C.border}`,
            borderRadius:7, padding:"6px 12px", cursor:"pointer",
            color:C.textMid, fontFamily:"'DM Sans',sans-serif", fontSize:12.5,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.ivoryDark}
            onMouseLeave={e=>e.currentTarget.style.background=C.ivory}
          >
            <QIc d="M15 18l-6-6 6-6" size={13} sw={2}/>
            Teklifler
          </button>
          <div style={{ width:1, height:20, background:C.borderLight }}/>
          <span style={{
            fontSize:12, color:C.textFaint, fontFamily:"'DM Mono',monospace",
            background:C.ivory, border:`1px solid ${C.borderLight}`,
            padding:"3px 8px", borderRadius:5,
          }}>{q.id}</span>
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", lineHeight:1.2 }}>
              Teklif #{q.id}
            </div>
            <div style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>
              {q.flag} {q.customer} · {q.tour}
            </div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <QStatusBadge status={q.status}/>
          <div style={{ width:1, height:20, background:C.borderLight }}/>
          <div style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>
            Geçerlilik: <span style={{ color:C.text, fontWeight:500 }}>{q.validUntil}</span>
          </div>
          <button style={{
            padding:"7px 14px", borderRadius:7,
            border:`1.5px solid ${C.gold}`, background:C.goldPale,
            cursor:"pointer", color:C.gold,
            fontFamily:"'DM Sans',sans-serif", fontSize:12.5, fontWeight:500,
            display:"flex", alignItems:"center", gap:6,
          }}>
            <QIc d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" size={13} sw={1.8}/>
            Düzenle
          </button>
        </div>
      </div>

      {}
      <div className="rsp-split" style={{ display:"grid", gridTemplateColumns:"1fr 1fr 280px", gap:18, alignItems:"start" }}>

        {}
        <div style={{ display:"flex", flexDirection:"column", gap:18 }}>

          {}
          <QCard>
            <QCardHead title="Misafir Bilgileri"/>
            <QInfoRow label="Ad Soyad"  value={`${q.flag} ${q.customer}`} bold/>
            <QInfoRow label="Ülke"      value={q.country}/>
            <QInfoRow label="E-posta"   value="sarah.johnson@email.com" mono/>
            <QInfoRow label="Telefon"   value="+61 412 855 903" mono/>
            <div style={{ padding:"10px 20px" }}>
              <span style={{
                fontSize:11.5, color:C.textFaint,
                fontFamily:"'DM Sans',sans-serif",
              }}>Talep: <a style={{ color:C.blue, textDecoration:"none", fontWeight:500 }}>LEAD-001 →</a></span>
            </div>
          </QCard>

          {}
          <QCard>
            <QCardHead title="Tur Detayları"/>
            <QInfoRow label="Tur"         value={q.tour} bold/>
            <QInfoRow label="Tarih"       value={q.dateRange}/>
            <QInfoRow label="Kişi Sayısı" value={`${q.pax} kişi`}/>
            <QInfoRow label="Karşılama"   value="Otel Karşılama (The Marmara Pera)"/>
            <div style={{ padding:"12px 20px" }}>
              <div style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginBottom:6 }}>Özel Talepler</div>
              <div style={{
                fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif",
                background:C.ivory, borderRadius:8, padding:"10px 12px",
                border:`1px solid ${C.borderLight}`, lineHeight:1.6,
              }}>
                Boğaz turu seçeneğiyle ilgileniyor. Vejetaryen yemek tercihi.
              </div>
            </div>
          </QCard>

          {}
          <QCard>
            <QCardHead title="Dahil Hizmetler"/>
            <div style={{ padding:"8px 20px 12px" }}>
              {tour.included.map((s,i)=><CheckItem key={i} label={s} checked={true}/>)}
            </div>
          </QCard>

          <QCard>
            <QCardHead title="Dahil Olmayan Hizmetler"/>
            <div style={{ padding:"8px 20px 12px" }}>
              {tour.excluded.map((s,i)=><CheckItem key={i} label={s} checked={false}/>)}
            </div>
          </QCard>
        </div>

        {}
        <div style={{ display:"flex", flexDirection:"column", gap:18 }}>

          {}
          <QCard>
            <div style={{
              background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
              padding:"20px 22px",
            }}>
              <div style={{ fontSize:11, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.09em", marginBottom:12 }}>Fiyatlandırma</div>
              <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                <span style={{ fontSize:36, fontWeight:700, color:C.goldLight, fontFamily:"'Playfair Display',serif" }}>{fmtQ(q.total)}</span>
                <span style={{ fontSize:13, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Sans',sans-serif" }}>{q.currency}</span>
              </div>
              <div style={{ fontSize:13, color:"rgba(248,245,238,0.6)", fontFamily:"'DM Sans',sans-serif", marginTop:4 }}>
                {fmtQ(q.unitPrice)} × {q.pax} kişi
              </div>
            </div>
            <div style={{ padding:"4px 0 0" }}>
              {[
                { label:"Kişi Başı Fiyat", val:fmtQ(q.unitPrice) },
                { label:"Kişi Sayısı",     val:`× ${q.pax}` },
                { label:"Toplam Tutar",    val:fmtQ(q.total), bold:true, gold:true },
                { label:"Kapora",          val:fmtQ(q.deposit), amber:true },
                { label:"Kalan Ödeme",     val:fmtQ(q.remaining) },
              ].map((r,i,arr)=>(
                <div key={i} style={{
                  display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"11px 22px",
                  borderBottom: i<arr.length-1 ? `1px solid ${C.borderLight}` : "none",
                  background: r.gold ? C.goldPale : "transparent",
                }}>
                  <span style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>{r.label}</span>
                  <span style={{
                    fontSize: r.bold ? 17 : 14,
                    fontWeight: r.bold ? 700 : 500,
                    color: r.gold ? C.gold : r.amber ? C.amber : C.text,
                    fontFamily:"'Playfair Display',serif",
                  }}>{r.val}</span>
                </div>
              ))}
            </div>
            {}
            <div style={{ padding:"14px 22px", background:C.ivory, borderTop:`1px solid ${C.borderLight}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                <span style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Ödeme İlerlemesi</span>
                <span style={{ fontSize:11.5, color:C.gold, fontFamily:"'DM Sans',sans-serif", fontWeight:600 }}>
                  {safePct(q.deposit, q.total)}
                </span>
              </div>
              <div style={{ height:6, background:C.ivoryDark, borderRadius:99, overflow:"hidden" }}>
                <div style={{ width:`${safePctNum(q.deposit, q.total)}%`, height:"100%", background:C.gold, borderRadius:99 }}/>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:5 }}>
                <span style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{fmtQ(q.deposit)} ödendi</span>
                <span style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{fmtQ(q.remaining)} kaldı</span>
              </div>
            </div>
          </QCard>

          {}
          <QCard>
            <QCardHead title="Teklif Durumu"/>
            <div style={{ padding:"16px 20px" }}>
              {Object.entries(QUOTE_STATUS).map(([s,m],i,arr)=>{
                const on = s === q.status;
                return (
                  <div key={s} style={{
                    display:"flex", alignItems:"center", gap:12,
                    padding:"10px 0",
                    borderBottom: i<arr.length-1 ? `1px solid ${C.borderLight}` : "none",
                  }}>
                    <div style={{
                      width:22, height:22, borderRadius:"50%", flexShrink:0,
                      border: on ? `none` : `1.5px solid ${C.border}`,
                      background: on ? m.color : "transparent",
                      display:"flex", alignItems:"center", justifyContent:"center",
                    }}>
                      {on && <QIc d="M20 6L9 17l-5-5" size={12} sw={2.5} color="#fff"/>}
                    </div>
                    <span style={{
                      fontSize: on ? 13.5 : 13, fontWeight: on ? 600 : 400,
                      color: on ? m.color : C.textMuted,
                      fontFamily:"'DM Sans',sans-serif",
                    }}>{s}</span>
                    {on && (
                      <span style={{
                        marginLeft:"auto", fontSize:10.5, fontFamily:"'DM Sans',sans-serif",
                        color:C.textFaint,
                      }}>Güncel durum</span>
                    )}
                  </div>
                );
              })}
            </div>
          </QCard>

          {}
          <QuoteBuilder/>
        </div>

        {}
        <div style={{ display:"flex", flexDirection:"column", gap:18 }}>

          {}
          <QCard>
            <div style={{
              background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
              padding:"14px 16px",
              display:"flex", alignItems:"center", gap:8,
            }}>
              <span style={{ fontSize:11, fontWeight:600, color:"rgba(248,245,238,0.55)", fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.09em" }}>Hızlı İşlemler</span>
            </div>
            <div style={{ padding:"12px" }}>
              {ACTIONS.map((a,i)=>{
                return (
                  <button key={i}
                    onMouseEnter={e=>e.currentTarget.style.background=e.currentTarget.dataset.hover||C.ivory}
                    onMouseLeave={e=>e.currentTarget.style.background=""}
                    onClick={()=>{
                      if(a.label==="PDF Önizleme") setShowPreview(true);
                      else if(a.label==="PDF İndir") { setShowPreview(true); }
                      else if(a.label==="Email Teklifi Oluştur") setShowPreview(true);
                      else if(a.label==="Rezervasyona Dönüştür") handleConvertToReservation();
                    }}
                    style={{
                      display:"flex", alignItems:"center", gap:10,
                      width:"100%", padding:"9px 12px", borderRadius:8, marginBottom:i<ACTIONS.length-1?6:0,
                      border: a.primary ? "none" : a.wa ? `1px solid #128C7E44` : `1px solid ${C.border}`,
                      background: a.primary ? C.navy : a.wa ? "#F2FAF8" : C.white,
                      cursor:"pointer",
                      color: a.primary ? C.white : a.wa ? "#128C7E" : C.text,
                      fontFamily:"'DM Sans',sans-serif", fontSize:12.5,
                      fontWeight: a.primary ? 600 : 400,
                      transition:"background 0.12s", textAlign:"left",
                    }}>
                    <QIc d={a.icon} size={14} sw={a.primary?2:1.6}/>
                    {a.label}
                  </button>
                );
              })}
            </div>
          </QCard>

          {}
          <QCard>
            <QCardHead title="Teklif Bilgileri"/>
            <div style={{ padding:"4px 0" }}>
              {[
                { label:"Oluşturulma",    val:q.createdAt },
                { label:"Bağlı Talep",    val:q.leadId,           idType:"lead" },
                { label:"Geçerlilik",     val:q.validUntil, red: q.status==="Süresi Doldu" },
                { label:"Para Birimi",    val:q.currency },
              ].map((r,i)=>(
                <div key={i} style={{
                  display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"10px 18px",
                  borderBottom:`1px solid ${C.borderLight}`,
                }}>
                  <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{r.label}</span>
                  {r.idType ? <IDLink id={r.val} type={r.idType}/> : <span style={{ fontSize:12.5, color:r.red?C.red:C.text, fontFamily:"'DM Sans',sans-serif", fontWeight:500 }}>{r.val}</span>}
                </div>
              ))}
            </div>
          </QCard>
        </div>
      </div>
    </div>
  );
}

const LOGO_URI = "/seffafdeselogo.png";

const DEFAULT_INCLUDED = [
  "Licensed Professional Guide",
  "Hotel Pickup & Drop-off",
  "All Entrance Tickets",
  "Lunch (Local Restaurant)",
  "Private Transportation",
  "Bottled Water",
];
const DEFAULT_EXCLUDED = [
  "Personal Expenses",
  "Drinks",
  "Tips (Optional)",
  "Any Additional Activities Not Mentioned",
];
const TOUR_OPTIONS = DB.tours
  .filter(t => t.status === "Aktif")
  .map(t => ({ name: t.name, duration: t.duration, basePrice: t.basePrice })); // from DB
const CURRENCY_OPTIONS = ["EUR","USD","TRY","GBP"];
const PICKUP_OPTIONS   = ["Hotel Pickup","Airport Transfer","Custom Location","Cruise Port"];

function FLabel({ children }) {
  return (
    <div style={{
      fontSize:10.5, fontWeight:600, color:C.textFaint,
      textTransform:"uppercase", letterSpacing:"0.09em",
      fontFamily:"DM Sans,sans-serif", marginBottom:5,
    }}>{children}</div>
  );
}
function FInput({ value, onChange, placeholder, type="text" }) {
  const [foc,setFoc] = useState(false);
  return (
    <input type={type} value={value} onChange={e=>onChange(e.target.value)}
      placeholder={placeholder}
      onFocus={()=>setFoc(true)} onBlur={()=>setFoc(false)}
      style={{
        width:"100%", padding:"9px 12px",
        border:`1px solid ${foc?C.gold:C.border}`,
        borderRadius:7, background:C.ivory,
        fontSize:13, color:C.text,
        fontFamily:"DM Sans,sans-serif", outline:"none",
        boxShadow: foc?`0 0 0 3px ${C.gold}18`:"none",
        transition:"border-color .15s, box-shadow .15s",
        boxSizing:"border-box",
      }}/>
  );
}
function QFSelect({ value, onChange, options }) {
  return (
    <select value={value} onChange={e=>onChange(e.target.value)} style={{
      width:"100%", padding:"9px 12px",
      border:`1px solid ${C.border}`, borderRadius:7,
      background:C.ivory, fontSize:13, color:C.text,
      fontFamily:"DM Sans,sans-serif", outline:"none",
      boxSizing:"border-box", cursor:"pointer",
    }}>
      {options.map(o=><option key={o}>{o}</option>)}
    </select>
  );
}
function FSectionHead({ n, title }) {
  return (
    <div style={{
      display:"flex", alignItems:"center", gap:10, marginBottom:16,
    }}>
      <div style={{
        width:24, height:24, borderRadius:"50%", flexShrink:0,
        background:C.navy, display:"flex", alignItems:"center", justifyContent:"center",
      }}>
        <span style={{fontSize:11, fontWeight:700, color:C.goldLight, fontFamily:"DM Sans,sans-serif"}}>{n}</span>
      </div>
      <span style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"Playfair Display,serif"}}>{title}</span>
      <div style={{flex:1, height:1, background:C.borderLight}}/>
    </div>
  );
}
function FCheckList({ items, setItems, accent }) {
  const [newVal, setNewVal] = useState("");
  function toggle(i) { setItems(prev=>prev.map((x,j)=>j===i?{...x,on:!x.on}:x)); }
  function remove(i) { setItems(prev=>prev.filter((_,j)=>j!==i)); }
  function add()     { if(newVal.trim()){ setItems(prev=>[...prev,{label:newVal.trim(),on:true}]); setNewVal(""); } }
  return (
    <div>
      {items.map((it,i)=>(
        <div key={i} style={{
          display:"flex", alignItems:"center", gap:8,
          padding:"7px 0", borderBottom:`1px solid ${C.borderLight}`,
        }}>
          <div onClick={()=>toggle(i)} style={{
            width:18, height:18, borderRadius:4, flexShrink:0, cursor:"pointer",
            border: it.on ? "none" : `1.5px solid ${C.border}`,
            background: it.on ? (accent||C.green) : C.white,
            display:"flex", alignItems:"center", justifyContent:"center",
            transition:"background .15s",
          }}>
            {it.on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>}
          </div>
          <span style={{
            flex:1, fontSize:12.5, color:it.on?C.text:C.textFaint,
            fontFamily:"DM Sans,sans-serif",
            textDecoration:it.on?"none":"line-through",
          }}>{it.label}</span>
          <button onClick={()=>remove(i)} style={{
            background:"none", border:"none", cursor:"pointer",
            color:C.textFaint, padding:2, lineHeight:1,
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      ))}
      <div style={{display:"flex", gap:6, marginTop:10}}>
        <input value={newVal} onChange={e=>setNewVal(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&add()}
          placeholder="Yeni öğe ekle..."
          style={{
            flex:1, padding:"7px 10px",
            border:`1px solid ${C.border}`, borderRadius:6,
            background:C.ivory, fontSize:12.5, color:C.text,
            fontFamily:"DM Sans,sans-serif", outline:"none",
            boxSizing:"border-box",
          }}/>
        <button onClick={add} style={{
          padding:"7px 12px", borderRadius:6, cursor:"pointer",
          background:C.navy, border:"none", color:C.white,
          fontSize:12, fontFamily:"DM Sans,sans-serif",
        }}>+ Ekle</button>
      </div>
    </div>
  );
}

function ProposalPreview({ form, included, excluded }) {
  const sym = form.currency==="TRY"?"₺":form.currency==="GBP"?"£":form.currency==="USD"?"$":"€";
  const total    = (form.pricePerPerson||0) * (form.guestCount||1);
  const discount = Math.round(total * (form.discountPct||0) / 100);
  const net      = total - discount;
  const deposit  = Math.round(net * (form.depositPct||25) / 100);
  const remaining= net - deposit;
  const today    = new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});

  const incOn = included.filter(x=>x.on);
  const excOn = excluded.filter(x=>x.on);

  return (
    <div style={{
      background:"#F8F5EE",
      fontFamily:"DM Sans,sans-serif",
      fontSize:13, color:"#1B2D4F",
      maxWidth:640, margin:"0 auto",
      boxShadow:"0 4px 40px rgba(27,45,79,0.14)",
      borderRadius:4,
      overflow:"hidden",
    }}>

      {}
      <div style={{
        background:"#1B2D4F", padding:"18px 36px",
        display:"flex", alignItems:"center", justifyContent:"space-between",
      }}>
        <img src={LOGO_URI} alt="Dese Tour" style={{
          height:44, width:"auto",
          mixBlendMode:"screen", opacity:0.95,
        }}/>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:10, letterSpacing:"0.14em", color:"rgba(248,245,238,0.5)", textTransform:"uppercase", marginBottom:3}}>DATE</div>
          <div style={{fontSize:13.5, color:"#FAF7F0", fontWeight:500}}>{today}</div>
        </div>
      </div>

      {}
      <div style={{height:2, background:"linear-gradient(90deg, #C9A84C 0%, #E8D89A 50%, #C9A84C 100%)"}}/>

      {}
      <div style={{padding:"32px 36px 28px"}}>

        {}
        <div style={{
          fontSize:10, letterSpacing:"0.18em", textTransform:"uppercase",
          color:"#C9A84C", fontWeight:600, marginBottom:10,
        }}>PROPOSAL</div>

        {}
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20}}>
          <div>
            <div style={{fontSize:10.5, color:"#8A8070", marginBottom:4}}>Prepared for ——</div>
            <div style={{
              fontSize:28, fontWeight:700, color:"#1B2D4F",
              fontFamily:"Playfair Display,serif", lineHeight:1.1,
              marginBottom:10,
            }}>{form.guestName||"Guest Name"}</div>
            <div style={{display:"flex", flexDirection:"column", gap:5}}>
              {form.nationality && (
                <div style={{display:"flex", alignItems:"center", gap:7, fontSize:12.5, color:"#4A5568"}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth="1.8" strokeLinecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z"/></svg>
                  {form.nationality}
                </div>
              )}
              <div style={{display:"flex", alignItems:"center", gap:7, fontSize:12.5, color:"#4A5568"}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth="1.8" strokeLinecap="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75"/></svg>
                {form.guestCount||1} Guest{(form.guestCount||1)>1?"s":""}
              </div>
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:10.5, color:"#8A8070", marginBottom:4}}>Proposal No.</div>
            <div style={{fontSize:18, fontWeight:700, color:"#1B2D4F", fontFamily:"Playfair Display,serif"}}>
              {form.proposalNo||"Q-2026-001"}
            </div>
            <div style={{width:40, height:1.5, background:"#C9A84C", marginLeft:"auto", marginTop:6}}/>
          </div>
        </div>

        {}
        <div style={{height:1, background:"linear-gradient(90deg,#C9A84C,transparent)", marginBottom:24}}/>

        {}
        <div style={{textAlign:"center", marginBottom:24}}>
          <h2 style={{
            fontSize:24, fontWeight:700, color:"#1B2D4F",
            fontFamily:"Playfair Display,serif", lineHeight:1.2,
            margin:0,
          }}>{form.tourName||"Tour Experience"}</h2>
        </div>

        {}
        <div style={{
          display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr",
          gap:0, marginBottom:28,
          border:`1px solid #E4DDD0`, borderRadius:8, overflow:"hidden",
        }}>
          {[
            { icon:"M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z", label:"Date",     val:form.tourDate||"—" },
            { icon:"M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",                                              label:"Duration", val:form.duration||"—" },
            { icon:"M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z M13 17H9m4 0h2m2-5H3M5 12V5h14v7", label:"Pickup",   val:form.pickup||"Hotel Pickup" },
            { icon:"M8 12h.01M12 12h.01M16 12h.01M21 3H3a2 2 0 00-2 2v13a2 2 0 002 2h5l3 3 3-3h5a2 2 0 002-2V5a2 2 0 00-2-2z", label:"Special Request", val:form.specialRequests||(form.guestCount>4?"Group booking":"Standard") },
          ].map((d,i)=>(
            <div key={i} style={{
              padding:"14px 14px",
              borderRight: i<3?`1px solid #E4DDD0`:"none",
              background:"#fff",
            }}>
              <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:5}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth="1.7" strokeLinecap="round">
                  <path d={d.icon}/>
                </svg>
                <span style={{fontSize:9.5, color:"#8A8070", textTransform:"uppercase", letterSpacing:"0.08em"}}>{d.label}</span>
              </div>
              <div style={{fontSize:12.5, fontWeight:500, color:"#1B2D4F", lineHeight:1.4}}>{d.val}</div>
            </div>
          ))}
        </div>

        {}
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 200px", gap:12, marginBottom:28}}>

          {}
          <div style={{gridColumn:"1/2"}}>
            <div style={{fontSize:10, color:"#C9A84C", letterSpacing:"0.12em", textTransform:"uppercase", fontWeight:600, marginBottom:8}}>EXPERIENCE OVERVIEW</div>
            <div style={{fontSize:12.5, color:"#4A5568", lineHeight:1.7}}>
              Discover the best of Istanbul with your private guide. This customizable experience blends iconic landmarks, hidden gems and local culture for an unforgettable day.
            </div>
            <div style={{width:36, height:1.5, background:"#C9A84C", marginTop:12}}/>
          </div>

          {}
          <div style={{
            border:`1px solid #E4DDD0`, borderRadius:8, padding:"16px 18px",
            background:"#fff",
          }}>
            <div style={{fontSize:10.5, fontWeight:600, color:"#1B2D4F", letterSpacing:"0.06em", marginBottom:12}}>PRICING SUMMARY</div>
            <div style={{display:"flex", justifyContent:"space-between", marginBottom:8}}>
              <span style={{fontSize:12.5, color:"#4A5568"}}>Price per Person</span>
              <span style={{fontSize:12.5, fontWeight:500}}>{sym}{form.pricePerPerson||0}</span>
            </div>
            <div style={{display:"flex", justifyContent:"space-between", marginBottom:8}}>
              <span style={{fontSize:12.5, color:"#4A5568"}}>Guests</span>
              <span style={{fontSize:12.5, fontWeight:500}}>{form.guestCount||1}</span>
            </div>
            {discount>0 && (
              <div style={{display:"flex", justifyContent:"space-between", marginBottom:8}}>
                <span style={{fontSize:12.5, color:"#C0392B"}}>Discount ({form.discountPct}%)</span>
                <span style={{fontSize:12.5, color:"#C0392B"}}>-{sym}{discount}</span>
              </div>
            )}
            <div style={{height:1, background:"#E4DDD0", margin:"10px 0"}}/>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline"}}>
              <span style={{fontSize:13, fontWeight:600}}>Total Price</span>
              <span style={{fontSize:20, fontWeight:700, color:"#1B2D4F", fontFamily:"Playfair Display,serif"}}>{sym}{net}</span>
            </div>
          </div>

          {}
          <div style={{
            background:"#1B2D4F", borderRadius:8, padding:"16px 14px",
            display:"flex", flexDirection:"column", justifyContent:"center",
          }}>
            <div style={{fontSize:9.5, letterSpacing:"0.14em", color:"#C9A84C", textTransform:"uppercase", fontWeight:600, marginBottom:6}}>DEPOSIT REQUIRED</div>
            <div style={{fontSize:30, fontWeight:700, color:"#FAF7F0", fontFamily:"Playfair Display,serif", lineHeight:1}}>{sym}{deposit}</div>
            <div style={{height:1, background:"rgba(201,168,76,0.4)", margin:"10px 0"}}/>
            <div style={{fontSize:9.5, letterSpacing:"0.14em", color:"#C9A84C", textTransform:"uppercase", fontWeight:600, marginBottom:6}}>REMAINING BALANCE</div>
            <div style={{fontSize:24, fontWeight:700, color:"#FAF7F0", fontFamily:"Playfair Display,serif", lineHeight:1}}>{sym}{remaining}</div>
          </div>
        </div>

        {}
        <div style={{height:1, background:"linear-gradient(90deg,#C9A84C,transparent)", marginBottom:24}}/>

        {}
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:20, marginBottom:24}}>
          {}
          <div>
            <div style={{fontSize:10, color:"#C9A84C", letterSpacing:"0.12em", textTransform:"uppercase", fontWeight:600, marginBottom:10}}>INCLUDED SERVICES</div>
            {incOn.map((s,i)=>(
              <div key={i} style={{display:"flex", alignItems:"flex-start", gap:8, marginBottom:7}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth="2" strokeLinecap="round" style={{marginTop:1, flexShrink:0}}><path d="M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3"/></svg>
                <span style={{fontSize:12, color:"#1B2D4F", lineHeight:1.4}}>{s.label}</span>
              </div>
            ))}
          </div>
          {}
          <div>
            <div style={{fontSize:10, color:"#8A8070", letterSpacing:"0.12em", textTransform:"uppercase", fontWeight:600, marginBottom:10}}>NOT INCLUDED</div>
            {excOn.map((s,i)=>(
              <div key={i} style={{display:"flex", alignItems:"flex-start", gap:8, marginBottom:7}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8A8070" strokeWidth="2" strokeLinecap="round" style={{marginTop:1, flexShrink:0}}><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
                <span style={{fontSize:12, color:"#4A5568", lineHeight:1.4}}>{s.label}</span>
              </div>
            ))}
          </div>
          {}
          <div>
            <div style={{fontSize:10, color:"#C9A84C", letterSpacing:"0.12em", textTransform:"uppercase", fontWeight:600, marginBottom:10}}>EXPERIENCE HIGHLIGHTS</div>
            {["Top historic sites","Scenic Bosphorus views","Photo stops & hidden gems","Local cuisine experience","Flexible & personalized"].map((h,i)=>(
              <div key={i} style={{display:"flex", alignItems:"center", gap:8, marginBottom:7}}>
                <div style={{width:6, height:6, borderRadius:"50%", background:"#C9A84C", flexShrink:0}}/>
                <span style={{fontSize:12, color:"#4A5568"}}>{h}</span>
              </div>
            ))}
          </div>
        </div>

        {}
        <div style={{height:1, background:"linear-gradient(90deg,#C9A84C,transparent)", marginBottom:20}}/>

        {}
        {form.specialRequests && (
          <div style={{
            background:"#fff", borderRadius:8, padding:"12px 16px",
            border:`1px solid #E4DDD0`, marginBottom:20,
          }}>
            <div style={{fontSize:9.5, color:"#C9A84C", textTransform:"uppercase", letterSpacing:"0.12em", fontWeight:600, marginBottom:6}}>SPECIAL REQUESTS</div>
            <div style={{fontSize:12.5, color:"#4A5568", lineHeight:1.6}}>{form.specialRequests}</div>
          </div>
        )}

        {}
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:16, marginBottom:0}}>
          <div>
            <div style={{fontSize:9.5, color:"#C9A84C", textTransform:"uppercase", letterSpacing:"0.12em", fontWeight:600, marginBottom:8}}>TERMS & NOTES</div>
            {[
              "This proposal is valid for 7 days.",
              `Prices quoted in ${form.currency||"EUR"}.`,
              "Deposit required to confirm.",
              "Itinerary can be customized.",
            ].map((t,i)=>(
              <div key={i} style={{display:"flex", gap:6, marginBottom:5}}>
                <span style={{color:"#C9A84C", flexShrink:0}}>•</span>
                <span style={{fontSize:11.5, color:"#4A5568", lineHeight:1.4}}>{t}</span>
              </div>
            ))}
          </div>
          <div>
            <div style={{fontSize:9.5, color:"#C9A84C", textTransform:"uppercase", letterSpacing:"0.12em", fontWeight:600, marginBottom:8}}>PREPARED BY</div>
            <div style={{width:28, height:1.5, background:"#C9A84C", marginBottom:8}}/>
            <div style={{fontSize:14, fontWeight:700, color:"#1B2D4F", fontFamily:"Playfair Display,serif"}}>{getAuthContext().displayName}</div>
            <div style={{fontSize:12, color:"#8A8070", marginTop:2}}>{getAuthContext().role}</div>
          </div>
          <div>
            <div style={{fontSize:9.5, color:"#C9A84C", textTransform:"uppercase", letterSpacing:"0.12em", fontWeight:600, marginBottom:8}}>THANK YOU!</div>
            <div style={{width:28, height:1.5, background:"#C9A84C", marginBottom:8}}/>
            <div style={{fontSize:12, color:"#4A5568", lineHeight:1.6}}>We look forward to welcoming you to Istanbul.</div>
          </div>
        </div>
      </div>

      {}
      <div style={{
        background:"#1B2D4F", padding:"14px 36px",
        display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr",
        gap:12,
      }}>
        {[
          { icon:"M12 2a10 10 0 100 20A10 10 0 0012 2z M2 12h20", label:"www.desetour.com" },
          { icon:"M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6", label:"hello@desetour.com" },
          { icon:"M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.09-1.09a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z", label:"+90 555 123 45 67" },
          { icon:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z", label:"Istanbul, Türkiye" },
        ].map((f,i)=>(
          <div key={i} style={{display:"flex", alignItems:"center", gap:7}}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(248,245,238,0.5)" strokeWidth="1.8" strokeLinecap="round">
              <path d={f.icon}/>
            </svg>
            <span style={{fontSize:11, color:"rgba(248,245,238,0.55)", fontFamily:"DM Sans,sans-serif"}}>{f.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FormSections({
  guestName, setGuestName, nationality, setNationality,
  email, setEmail, phone, setPhone,
  tourName, changeTour, tourDate, setTourDate,
  duration, setDuration, guestCount, setGuestCount,
  pickup, setPickup, pricePerPerson, setPricePerPerson,
  currency, setCurrency, discountPct, setDiscountPct,
  depositPct, setDepositPct, specialReqs, setSpecialReqs,
  proposalNo, setProposalNo,
  included, setIncluded, excluded, setExcluded,
  sym, net, deposit, remaining,
}) {
  return (
    <div style={{display:"flex", flexDirection:"column", gap:24}}>

      {}
      <div>
        <FSectionHead n="1" title="Misafir Bilgileri"/>
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
          <div><FLabel>Ad Soyad</FLabel><FInput value={guestName}       onChange={setGuestName} placeholder="Sarah Johnson"/></div>
          <div><FLabel>Uyruk</FLabel><FInput value={nationality}     onChange={setNationality} placeholder="Avustralya"/></div>
          <div><FLabel>E-posta</FLabel><FInput value={email}           onChange={setEmail} placeholder="email@example.com" type="email"/></div>
          <div><FLabel>Telefon</FLabel><FInput value={phone}           onChange={setPhone} placeholder="+90 555 000 0000"/></div>
        </div>
      </div>

      {}
      <div>
        <FSectionHead n="2" title="Deneyim Bilgileri"/>
        <div style={{display:"flex", flexDirection:"column", gap:12}}>
          <div>
            <FLabel>Tur Adı</FLabel>
            <FSelect value={tourName}        onChange={changeTour} options={TOUR_OPTIONS.map(t=>t.name)}/>
          </div>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
            <div><FLabel>Tur Tarihi</FLabel><FInput value={tourDate}        onChange={setTourDate} placeholder="22 June 2026"/></div>
            <div><FLabel>Süre</FLabel><FInput value={duration}        onChange={setDuration} placeholder="8 Hours"/></div>
            <div>
              <FLabel>Kişi Sayısı</FLabel>
              <div style={{display:"flex", gap:6, flexWrap:"wrap", marginTop:2}}>
                {[1,2,3,4,5,6,7,8].map(n=>(
                  <button key={n} onClick={()=>setGuestCount(n)} style={{
                    width:36, height:34, borderRadius:6, cursor:"pointer",
                    border: n===guestCount?`1.5px solid ${C.gold}`:`1px solid ${C.border}`,
                    background: n===guestCount?C.goldPale:C.white,
                    color: n===guestCount?C.gold:C.textMid,
                    fontSize:13, fontWeight: n===guestCount?700:400,
                    fontFamily:"DM Sans,sans-serif", transition:"all .12s",
                  }}>{n}</button>
                ))}
              </div>
            </div>
            <div>
              <FLabel>Karşılama</FLabel>
              <FSelect value={pickup}          onChange={setPickup} options={PICKUP_OPTIONS}/>
            </div>
          </div>
        </div>
      </div>

      {}
      <div>
        <FSectionHead n="3" title="Fiyatlandırma"/>
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:14}}>
          <div>
            <FLabel>Kişi Başı Fiyat</FLabel>
            <div style={{position:"relative"}}>
              <span style={{position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.textFaint, fontSize:13, pointerEvents:"none"}}>{sym}</span>
              <input type="number" value={pricePerPerson}
                onChange={e=>setPricePerPerson(Number(e.target.value))}
                style={{
                  width:"100%", padding:"9px 12px 9px 24px",
                  border:`1px solid ${C.border}`, borderRadius:7,
                  background:C.ivory, fontSize:13, color:C.text,
                  fontFamily:"DM Sans,sans-serif", outline:"none",
                  boxSizing:"border-box",
                }}/>
            </div>
          </div>
          <div>
            <FLabel>Para Birimi</FLabel>
            <FSelect value={currency}        onChange={setCurrency} options={CURRENCY_OPTIONS}/>
          </div>
          <div>
            <FLabel>İndirim</FLabel>
            <div style={{display:"flex", gap:5}}>
              {[0,5,10,15,20].map(d=>(
                <button key={d} onClick={()=>setDiscountPct(d)} style={{
                  flex:1, padding:"8px 0", borderRadius:6, cursor:"pointer",
                  border: d===discountPct?`1.5px solid ${C.red}`:`1px solid ${C.border}`,
                  background: d===discountPct?"#FDECEC":C.white,
                  color: d===discountPct?C.red:C.textMid,
                  fontSize:12, fontFamily:"DM Sans,sans-serif", transition:"all .12s",
                }}>%{d}</button>
              ))}
            </div>
          </div>
        </div>

        {}
        <div style={{
          display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr",
          gap:10, padding:"14px 16px",
          background:"#1B2D4F", borderRadius:10,
        }}>
          {[
            { label:"Toplam",  val:`${sym}${net}`,       gold:false },
            { label:"Kapora",  val:`${sym}${deposit}`,   gold:true  },
            { label:"Kalan",   val:`${sym}${remaining}`, gold:false },
          ].map((r,i)=>(
            <div key={i} style={{textAlign:"center"}}>
              <div style={{fontSize:10, color:"rgba(248,245,238,0.45)", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:4, fontFamily:"DM Sans,sans-serif"}}>{r.label}</div>
              <div style={{fontSize:18, fontWeight:700, color:r.gold?C.goldLight:"#FAF7F0", fontFamily:"Playfair Display,serif"}}>{r.val}</div>
            </div>
          ))}
          <div>
            <div style={{fontSize:10, color:"rgba(248,245,238,0.45)", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:6, fontFamily:"DM Sans,sans-serif"}}>Kapora %</div>
            <div style={{display:"flex", gap:4}}>
              {[20,25,30,50].map(d=>(
                <button key={d} onClick={()=>setDepositPct(d)} style={{
                  flex:1, padding:"4px 0", borderRadius:5, cursor:"pointer",
                  border: d===depositPct?`1px solid ${C.goldLight}`:`1px solid rgba(255,255,255,0.15)`,
                  background: d===depositPct?"rgba(201,168,76,0.2)":"transparent",
                  color: d===depositPct?C.goldLight:"rgba(248,245,238,0.5)",
                  fontSize:10.5, fontFamily:"DM Sans,sans-serif",
                }}>%{d}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {}
      <div>
        <FSectionHead n="4" title="Dahil Hizmetler"/>
        <FCheckList items={included} setItems={setIncluded}/>
      </div>

      {}
      <div>
        <FSectionHead n="5" title="Dahil Olmayan Hizmetler"/>
        <FCheckList items={excluded} setItems={setExcluded} accent={C.red}/>
      </div>

      {}
      <div>
        <FSectionHead n="6" title="Özel Talepler"/>
        <textarea value={specialReqs}
          onChange={e=>setSpecialReqs(e.target.value)}
          placeholder="Müşterinin özel talepleri..."
          rows={3}
          style={{
            width:"100%", padding:"10px 12px",
            border:`1px solid ${C.border}`, borderRadius:7,
            background:C.ivory, fontSize:13, color:C.text,
            fontFamily:"DM Sans,sans-serif", outline:"none",
            boxSizing:"border-box", resize:"vertical", lineHeight:1.6,
          }}/>
      </div>

      {}
      <div>
        <FLabel>Teklif Numarası</FLabel>
        <FInput value={proposalNo}      onChange={setProposalNo} placeholder="Q-2026-007"/>
      </div>
    </div>
  );
}

function NewProposalPage({ onBack }) {

  const _pf = SESSION.getPrefill() || {};
  const [guestName,      setGuestName]      = useState(_pf.guestName     || "Sarah Johnson");
  const [nationality,    setNationality]    = useState(_pf.nationality   || "Australia");
  const [email,          setEmail]          = useState(_pf.email         || "sarah.johnson@email.com");
  const [phone,          setPhone]          = useState(_pf.phone         || "+61 412 855 903");
  const [tourName,       setTourName]       = useState(_pf.tourName      || "Private Istanbul Experience");
  const [tourDate,       setTourDate]       = useState(_pf.tourDate      || "22 June 2026");
  const [duration,       setDuration]       = useState(_pf.duration      || "8 Hours");
  const [guestCount,     setGuestCount]     = useState(_pf.guestCount    || 4);
  const [pickup,         setPickup]         = useState(_pf.pickup        || "Hotel Pickup");
  const [pricePerPerson, setPricePerPerson] = useState(_pf.pricePerPerson|| 90);
  const [currency,       setCurrency]       = useState(_pf.currency      || "EUR");
  const [discountPct,    setDiscountPct]    = useState(_pf.discountPct   || 0);
  const [saveErrs,  setSaveErrs]  = useState({});
  const [saveBusy,  setSaveBusy]  = useState(false);
  const [depositPct,     setDepositPct]     = useState(_pf.depositPct    || 25);
  const [specialReqs,    setSpecialReqs]    = useState(_pf.specialReqs   || "");
  const [proposalNo,     setProposalNo]     = useState(_pf.proposalNo    || "Q-2026-007");
  const [fromLeadId,     setFromLeadId]     = useState(_pf.fromLead      || null);

  const [included, setIncluded] = useState(
    DEFAULT_INCLUDED.map(l=>({label:l, on:true}))
  );
  const [excluded, setExcluded] = useState(
    DEFAULT_EXCLUDED.map(l=>({label:l, on:true}))
  );

  function changeTour(name) {
    const t = TOUR_OPTIONS.find(x=>x.name===name);
    setTourName(name);
    if(t) { setDuration(t.duration); setPricePerPerson(t.basePrice); }
  }

  const sym      = currency==="TRY"?"₺":currency==="GBP"?"£":currency==="USD"?"$":"€";
  const total    = (pricePerPerson||0) * (guestCount||1);
  const discount = Math.round(total*(discountPct||0)/100);
  const net      = total - discount;
  const deposit  = Math.round(net*(depositPct||25)/100);
  const remaining= net - deposit;

  const form = { guestName, nationality, email, phone, tourName, tourDate, duration,
    guestCount, pickup, pricePerPerson, currency, discountPct, depositPct,
    specialRequests:specialReqs, proposalNo };

  async function handleSaveQuote(status = "Taslak") {
    const errs = validate({
      guestName: { required:"Misafir adı zorunludur" },
      tourName:  { required:"Tur adı zorunludur" },
      guestCount:{ number:"Kişi sayısı sayısal olmalıdır", min:1, max:500 },
      currency:  { required:"Para birimi zorunludur" },
    }, { guestName, tourName, guestCount: String(guestCount), currency });

    const total = Math.round((pricePerPerson||0)*guestCount*(1-discountPct/100));
    if (total <= 0) errs.pricePerPerson = "Toplam tutar sıfırdan büyük olmalıdır";
    if (status === "Gönderildi" && !validUntil) errs.validUntil = "Geçerlilik tarihi zorunludur";

    setSaveErrs(errs);
    if (Object.keys(errs).length) { showToast("Lütfen form hatalarını düzeltin."); return; }

    setSaveBusy(true);
    try {
      const quoteRepo = getActiveRepo("quote");
      const custRepo  = getActiveRepo("customer");

      let custId = null;
      const existing = await Promise.resolve(custRepo.findByContact?.({ email: email||null, phone: phone||null })).catch(()=>null);
      if (existing) {
        custId = existing.id;
      } else if (guestName) {
        const newCust = await Promise.resolve(custRepo.create({
          name: guestName, email: email||"", phone: phone||"",
          country: nationality||"Diğer", language:"İngilizce", importType:"manual",
        })).catch(()=>null);
        custId = newCust?.id || null;
      }

      const items = [
        ...includedItems.filter(i=>i.on).map((i,idx) => ({
          type:"Dahil", label:i.label, quantity:1, unitPrice:0, total:0, sortOrder:idx,
        })),
        ...excludedItems.map((i,idx) => ({
          type:"Hariç", label:i.label, quantity:1, unitPrice:0, total:0, sortOrder:idx+50,
        })),
        { type:"Fiyat", label:`${guestCount} kişi × ${pricePerPerson} ${currency}`,
          quantity:guestCount, unitPrice:pricePerPerson, total, sortOrder:100 },
      ];

      const newQuote = await Promise.resolve(quoteRepo.create({
        customerId: custId, leadId: SESSION.getPrefill()?.leadId || null,
        tourName, tourId: DB.tours.find(t=>t.name===tourName)?.id || null,
        travelStart: tourDate||null, status,
        guestCount, pricePerPerson, currency,
        discountPct, discountAmount: Math.round(pricePerPerson*guestCount*discountPct/100),
        total, deposit: Math.round(total*0.25),
        validUntil: validUntil||null, notes: specialReqs||"",
        items,
      }));

      await autoLog("quote", newQuote?.id || "?", "created", `Teklif oluşturuldu: ${tourName}`);
      showToast("Teklif kaydedildi ✓");
      SESSION.clear?.();
      setTimeout(() => {
        if (newQuote?.id && NAV_REF.fn) NAV_REF.fn("/quotes/" + newQuote.id);
        else if (NAV_REF.fn) NAV_REF.fn("/quotes");
      }, 500);
    } catch (err) {
      showToast("Hata: " + err.message);
    } finally {
      setSaveBusy(false);
    }
  }

  async function handleConvertToReservation() {
    await handleSaveQuote("Onaylandı");
  }

  return (
    <div style={{display:"flex", flexDirection:"column", gap:0, height:"100%"}}>

      {}
      <div style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"14px 22px", marginBottom:16, flexShrink:0,
        display:"flex", alignItems:"center", justifyContent:"space-between", gap:16,
      }}>
        <div style={{display:"flex", alignItems:"center", gap:14}}>
          <button onClick={onBack} style={{
            display:"flex", alignItems:"center", gap:6,
            background:C.ivory, border:`1px solid ${C.border}`,
            borderRadius:7, padding:"6px 12px", cursor:"pointer",
            color:C.textMid, fontFamily:"DM Sans,sans-serif", fontSize:12.5,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.ivoryDark}
            onMouseLeave={e=>e.currentTarget.style.background=C.ivory}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
            Teklifler
          </button>
          <div style={{width:1, height:20, background:C.borderLight}}/>
          <div>
            <h1 style={{margin:0, fontSize:20, fontWeight:700, color:C.text, fontFamily:"Playfair Display,serif", lineHeight:1.2}}>
              Yeni Teklif Oluştur
            </h1>
            <p style={{margin:0, fontSize:12.5, color:C.textMuted, fontFamily:"DM Sans,sans-serif"}}>
              {fromLeadId
                ? <span>Talep <IDLink id={fromLeadId} type="lead"/> için oluşturuluyor — bilgiler otomatik dolduruldu</span>
                : "Formu doldurun — önizleme anlık güncellenir"}
            </p>
          </div>
        </div>
        <div style={{display:"flex", alignItems:"center", gap:10, flexShrink:0}}>
          {}
          <div style={{display:"flex", background:C.ivory, border:`1px solid ${C.border}`, borderRadius:8, padding:2}}>
            {[{k:"form",l:"Form"},{k:"preview",l:"Önizleme"}].map(({k,l})=>(
              <button key={k} onClick={()=>setTab(k)} style={{
                padding:"5px 14px", borderRadius:6, cursor:"pointer",
                border:"none",
                background:tab===k?C.navy:"transparent",
                color:tab===k?C.white:C.textMuted,
                fontSize:12.5, fontWeight:tab===k?500:400,
                fontFamily:"DM Sans,sans-serif", transition:"all .12s",
              }}>{l}</button>
            ))}
          </div>
          {}
          {[
            { label:"PDF İndir",          icon:"M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3", style:{} },
            { label:"WhatsApp'a Kopyala",icon:"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z", style:{background:"#E7F5F3", color:"#128C7E", border:"1px solid #128C7E44"} },
            { label:"Rezervasyona Dönüştür",icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", primary:true, action:"convert" },
          ].map((a,i)=>(
            <button key={i} style={{
              display:"flex", alignItems:"center", gap:6,
              padding:"8px 14px", borderRadius:8, cursor:"pointer",
              border: a.primary?"none":a.style?.border||`1px solid ${C.border}`,
              background: a.primary?C.navy:a.style?.background||C.white,
              color: a.primary?C.white:a.style?.color||C.text,
              fontFamily:"DM Sans,sans-serif", fontSize:12.5,
              fontWeight:a.primary?600:400,
              transition:"background .12s",
            }}
              onMouseEnter={e=>{ if(a.primary) e.currentTarget.style.background=C.navyHover; }}
              onMouseLeave={e=>{ if(a.primary) e.currentTarget.style.background=C.navy; }}
              onClick={a.action==="convert" ? handleConvertToReservation : undefined}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d={a.icon}/></svg>
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {}
      <div style={{
        display:"flex", gap:20, alignItems:"flex-start",
        height:"calc(100vh - 180px)",
      }}>

        {}
        <div style={{
          flexShrink:0, width:420,
          background:C.white, border:`1px solid ${C.border}`,
          borderRadius:12, padding:"22px 22px",
          height:"100%", overflowY:"auto",
          boxSizing:"border-box",
        }}>
          <div style={{marginBottom:14}}>
            <div style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:"Playfair Display,serif", marginBottom:3}}>Teklif Formu</div>
            <div style={{fontSize:12, color:C.textFaint, fontFamily:"DM Sans,sans-serif"}}>Alanları doldurun — önizleme sağda anlık güncellenir.</div>
          </div>
          <FormSections
            guestName={guestName}       setGuestName={setGuestName}
            nationality={nationality}   setNationality={setNationality}
            email={email}               setEmail={setEmail}
            phone={phone}               setPhone={setPhone}
            tourName={tourName}         changeTour={changeTour}
            tourDate={tourDate}         setTourDate={setTourDate}
            duration={duration}         setDuration={setDuration}
            guestCount={guestCount}     setGuestCount={setGuestCount}
            pickup={pickup}             setPickup={setPickup}
            pricePerPerson={pricePerPerson} setPricePerPerson={setPricePerPerson}
            currency={currency}         setCurrency={setCurrency}
            discountPct={discountPct}   setDiscountPct={setDiscountPct}
            depositPct={depositPct}     setDepositPct={setDepositPct}
            specialReqs={specialReqs}   setSpecialReqs={setSpecialReqs}
            proposalNo={proposalNo}     setProposalNo={setProposalNo}
            included={included}         setIncluded={setIncluded}
            excluded={excluded}         setExcluded={setExcluded}
            sym={sym} net={net} deposit={deposit} remaining={remaining}
          />
        </div>

        {}
        <div style={{
          flex:1, minWidth:0,
          height:"100%", overflowY:"auto",
          borderRadius:12, background:C.ivoryDark,
          padding:20, boxSizing:"border-box",
        }}>
          {}
          <div style={{
            display:"flex", alignItems:"center", gap:8, justifyContent:"center",
            marginBottom:14,
          }}>
            <span style={{
              display:"inline-flex", alignItems:"center", gap:6,
              fontSize:11.5, color:C.green,
              fontFamily:"DM Sans,sans-serif", fontWeight:500,
              background:C.greenBg, padding:"4px 12px", borderRadius:99,
              border:`1px solid ${C.green}30`,
            }}>
              <span style={{width:6, height:6, borderRadius:"50%", background:C.green}}/>
              Canlı Önizleme
            </span>
          </div>
          <ProposalPreview form={form} included={included} excluded={excluded}/>
        </div>
      </div>
    </div>
  );
}

const RES_STATUS = {
  "Hazırlanıyor":  { color:"#6B3FA0", bg:"#F3EEF9", dot:"#6B3FA0" },
  "Rehber Atandı": { color:"#1A6FAE", bg:"#E8F2FB", dot:"#1A6FAE" },
  "Hazır":         { color:"#B8973A", bg:"#F5EDD4", dot:"#B8973A" },
  "Tamamlandı":    { color:"#2E7D52", bg:"#EBF5EF", dot:"#2E7D52" },
  "İptal":         { color:"#C0392B", bg:"#FDECEC", dot:"#C0392B" },
};

const PAY_STATUS = {
  "Ödendi":           { color:"#2E7D52", bg:"#EBF5EF" },
  "Kapora Ödendi":    { color:"#B8973A", bg:"#F5EDD4" },
  "Ödeme Bekliyor":   { color:"#C05621", bg:"#FEF0E8" },
  "Gecikmiş":         { color:"#C0392B", bg:"#FDECEC" },
};

const MOCK_RESERVATIONS = DB.reservations; // → centralized DB

const RES_TIMELINE_TEMPLATES = [
  { type:"created",  action:"Rezervasyon oluşturuldu",     icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6", dot:"#1A6FAE" },
  { type:"guide",    action:"Rehber atandı",               icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75", dot:"#6B3FA0" },
  { type:"pickup",   action:"Pickup bilgisi gönderildi",   icon:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z", dot:"#B8973A" },
  { type:"payment",  action:"Ödeme alındı",                icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20", dot:"#2E7D52" },
  { type:"complete", action:"Tur tamamlandı",              icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", dot:"#2E7D52" },
];

function RIc({ d, size=16, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function RBadge({ label, map, small }) {
  const m = map[label] || { color:C.textMuted, bg:C.ivoryDark };
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding: small ? "3px 8px" : "4px 10px",
      borderRadius:99, fontSize: small ? 11 : 11.5, fontWeight:500,
      color:m.color, background:m.bg, whiteSpace:"nowrap",
      fontFamily:"'DM Sans',sans-serif",
    }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:m.dot||m.color, flexShrink:0 }}/>
      {label}
    </span>
  );
}

function GuideChip({ name }) {
  if (!name) return (
    <span style={{
      fontSize:12, color:C.red, fontFamily:"'DM Sans',sans-serif",
      display:"inline-flex", alignItems:"center", gap:5,
      background:C.redBg, padding:"3px 8px", borderRadius:6,
    }}>
      <span style={{width:6, height:6, borderRadius:"50%", background:C.red}}/>
      Atanmadı
    </span>
  );
  const initials = name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
  return (
    <div style={{ display:"flex", alignItems:"center", gap:7 }}>
      <div style={{
        width:26, height:26, borderRadius:"50%", flexShrink:0,
        background:"rgba(27,45,79,0.09)", border:"1.5px solid rgba(27,45,79,0.14)",
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>
        <span style={{ fontSize:10, fontWeight:700, color:C.navy }}>{initials}</span>
      </div>
      <span style={{ fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap" }}>{name}</span>
    </div>
  );
}


/* -- NewReservationModal -------------------------------------------- */
function NewReservationModal({ onClose, onSuccess }) {
  const { isMobile } = useBreakpoint();
  const { mutate: mutRes } = useRepoMutation("reservation");
  const { data: custList } = useRepo("customer", "getAll");
  const { data: tourList } = useRepo("tour",     "getAll");
  const [custId,   setCustId]   = useState("");
  const [tourId,   setTourId]   = useState("");
  const [checkIn,  setCheckIn]  = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [pax,      setPax]      = useState("2");
  const [notes,    setNotes]    = useState("");
  const [errs,     setErrs]     = useState({});
  const [busy,     setBusy]     = useState(false);
  const customers = custList || [];
  const tours     = tourList || [];

  async function handleSubmit() {
    const e = {};
    if (!custId)   e.custId  = "Musteri seciniz";
    if (!checkIn)  e.checkIn = "Giris tarihi zorunludur";
    if (!checkOut) e.checkOut= "Cikis tarihi zorunludur";
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const { data, error } = await mutRes("create", {
        customerId: custId, tourId: tourId||null,
        checkIn, checkOut, paxAdult: parseInt(pax)||1, notes,
      });
      if (error) throw new Error(error);
      showToast("Rezervasyon olusturuldu.");
      onSuccess && onSuccess(data);
      onClose();
    } catch(err) {
      showToast("Rezervasyon olusturulurken bir hata olustu.");
    } finally { setBusy(false); }
  }

  return (
    <FormShell isMobile={isMobile} title="Yeni Rezervasyon" onClose={onClose} onSubmit={handleSubmit}
      submitLabel="Rezervasyonu Kaydet" submitting={busy}>
      <FGrid>
        <FRow label="Musteri" required error={errs.custId}>
          <select value={custId} onChange={e=>setCustId(e.target.value)}
            style={{width:"100%",padding:"9px 10px",borderRadius:7,border:`1.5px solid ${errs.custId?C.red:C.border}`,fontSize:13.5,color:C.text,background:C.white}}>
            <option value="">-- Musteri secin --</option>
            {customers.map(c=><option key={c.id} value={c.id}>{c.name||c.full_name||c.id}</option>)}
          </select>
          {customers.length===0 && AppConfig.useSupabase && (
            <div style={{fontSize:12,color:C.amber,marginTop:4}}>Once bir musteri olusturun.</div>
          )}
        </FRow>
        <FRow label="Tur (opsiyonel)">
          <select value={tourId} onChange={e=>setTourId(e.target.value)}
            style={{width:"100%",padding:"9px 10px",borderRadius:7,border:`1.5px solid ${C.border}`,fontSize:13.5,color:C.text,background:C.white}}>
            <option value="">-- Tur secin --</option>
            {tours.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </FRow>
      </FGrid>
      <FGrid>
        <FRow label="Giris Tarihi" required error={errs.checkIn}>
          <FText type="date" value={checkIn} onChange={setCheckIn} error={errs.checkIn}/>
        </FRow>
        <FRow label="Cikis Tarihi" required error={errs.checkOut}>
          <FText type="date" value={checkOut} onChange={setCheckOut} error={errs.checkOut}/>
        </FRow>
        <FRow label="Kisi Sayisi">
          <FText type="number" value={pax} onChange={setPax} placeholder="2"/>
        </FRow>
      </FGrid>
      <FRow label="Notlar" full>
        <FTextArea value={notes} onChange={setNotes} rows={3}/>
      </FRow>
    </FormShell>
  );
}
function ReservationsPage({ onSelect }) {
  const [showNewRes, setShowNewRes] = useState(false);
  const [activeTab, setActiveTab] = useState("Tümü");
  const [search, setSearch]       = useState("");
  const { data:repoRes, loading:resLoading, error:resError, reload:reloadRes }
    = useRepo("reservation", "getAll");

  const TABS = ["Tümü", "Hazırlanıyor", "Onaylandı", "Tur Günü", "Tamamlandı", "İptal"];

  const _allRes = repoRes ?? [];  // null while loading, empty when no data
  const filtered = _allRes.filter(r => {
    const tabOk  = activeTab === "Tümü" || r.opStatus === activeTab;
    const srchOk = !search ||
      (r.name||'').toLowerCase().includes(search.toLowerCase()) ||
      r.tour.toLowerCase().includes(search.toLowerCase()) ||
      r.id.toLowerCase().includes(search.toLowerCase());
    return tabOk && srchOk;
  });

  const counts = TABS.reduce((acc, t) => {
    acc[t] = t === "Tümü" ? _allRes.length
      : _allRes.filter(r => r.opStatus === t).length;
    return acc;
  }, {});

  const upcoming   = _allRes.filter(r => !["Tamamlandı","İptal"].includes(r.opStatus)).length;
  const noGuide    = _allRes.filter(r => !r.guide && r.opStatus !== "İptal").length;
  const pendingPay = _allRes.filter(r => r.payStatus === "Kapora Ödendi" || r.payStatus === "Ödeme Bekliyor").length;
  const completed  = _allRes.filter(r => r.opStatus === "Tamamlandı").length;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

      {}
      <div className="page-header" style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"22px 26px",
        display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:20,
      }}>
        <div>
          <h1 style={{ margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:5 }}>Rezervasyonlar</h1>
          <p style={{ margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>
            Onaylanan rezervasyonları ve operasyon süreçlerini yönetin.
          </p>
        </div>
        <div className="page-header-actions" style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          <div style={{ position:"relative" }}>
            <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.textFaint, pointerEvents:"none" }}>
              <RIc d="M21 21l-4.35-4.35 M17 11A6 6 0 105 11a6 6 0 0012 0z" size={14} sw={1.8}/>
            </span>
            <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Misafir, tur veya rezervasyon ara…"
              style={{
                paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
                border:`1px solid ${C.border}`, borderRadius:8,
                background:C.ivory, fontSize:13, color:C.text,
                fontFamily:"'DM Sans',sans-serif", outline:"none", width:240,
                transition:"border-color .15s, box-shadow .15s",
              }}
              onFocus={e=>{ e.target.style.borderColor=C.gold; e.target.style.boxShadow=`0 0 0 3px ${C.gold}20`; }}
              onBlur={e=>{ e.target.style.borderColor=C.border; e.target.style.boxShadow="none"; }}
            />
          </div>
          <button style={{
            display:"flex", alignItems:"center", gap:7,
            padding:"9px 16px", borderRadius:8,
            border:"none", background:C.navy, cursor:"pointer", color:C.white,
            fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.navyHover}
            onMouseLeave={e=>e.currentTarget.style.background=C.navy}
            onClick={()=>setShowNewRes(true)}
          >
            <RIc d="M12 5v14M5 12h14" size={14} sw={2.5}/>
            Yeni Rezervasyon
          </button>
        </div>
      </div>

      {}
      <div className="rsp-stat-grid" style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14 }}>
        {[
          { label:"Aktif Rezervasyon",   val:upcoming,  icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", color:C.blue, bg:C.blueBg },
          { label:"Rehber Atanmadı",     val:noGuide,   icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75", color:C.red, bg:C.redBg },
          { label:"Ödeme Bekleyen",      val:pendingPay,icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20", color:C.amber, bg:C.amberBg },
          { label:"Tamamlanan",          val:completed, icon:"M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3", color:C.green, bg:C.greenBg },
        ].map((k,i) => (
          <div key={i} style={{
            background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
            padding:"18px 20px", display:"flex", alignItems:"center", gap:14,
          }}>
            <div style={{
              width:42, height:42, borderRadius:10, flexShrink:0,
              background:k.bg, display:"flex", alignItems:"center", justifyContent:"center",
              color:k.color,
            }}>
              <RIc d={k.icon} size={18} sw={1.6}/>
            </div>
            <div>
              <div style={{ fontSize:26, fontWeight:700, color:k.color, fontFamily:"'Playfair Display',serif", lineHeight:1 }}>{k.val}</div>
              <div style={{ fontSize:12, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:4 }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {}
      <div style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden" }}>

        {}
        <div style={{ display:"flex", alignItems:"center", borderBottom:`1px solid ${C.borderLight}`, padding:"0 20px", overflowX:"auto" }}>
          {TABS.map(tab => {
            const on = activeTab === tab;
            return (
              <button key={tab} onClick={()=>setActiveTab(tab)} style={{
                padding:"13px 14px",
                border:"none", borderBottom: on ? `2px solid ${C.gold}` : "2px solid transparent",
                background:"transparent",
                color: on ? C.gold : C.textMuted,
                fontFamily:"'DM Sans',sans-serif", fontSize:13,
                fontWeight: on ? 600 : 400, cursor:"pointer",
                whiteSpace:"nowrap", marginBottom:-1,
                display:"flex", alignItems:"center", gap:6,
                transition:"color .12s",
              }}>
                {tab}
                {counts[tab] > 0 && (
                  <span style={{
                    minWidth:18, height:18, borderRadius:99, padding:"0 5px",
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:10.5, fontWeight:600,
                    background: on ? `${C.gold}22` : C.ivoryDark,
                    color: on ? C.gold : C.textFaint,
                  }}>{counts[tab]}</span>
                )}
              </button>
            );
          })}
          <div style={{ marginLeft:"auto", padding:"0 4px", flexShrink:0 }}>
            <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{filtered.length} rezervasyon</span>
          </div>
        </div>

        {}
        {filtered.length === 0 ? (
          <div style={{ padding:"60px", textAlign:"center" }}>
            <div style={{ fontSize:32, opacity:.2, marginBottom:12 }}>📋</div>
            <div style={{ fontSize:15, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6 }}>Rezervasyon bulunamadı.</div>
            <div style={{ fontSize:13, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>Bu filtre için kayıt yok.</div>
          </div>
        ) : resLoading ? (
          <div style={{padding:"20px"}}><LoadingState label="Rezervasyonlar yükleniyor…"/></div>
        ) : resError ? (
          <div style={{padding:"20px"}}><ErrorState message={resError} onRetry={reloadRes}/></div>
        ) : (
          <>
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ borderBottom:`1px solid ${C.border}`, background:C.ivory }}>
                  {["Rezervasyon No","Misafir","Tur","Tarih / Saat","Kişi","Rehber","Ödeme","Operasyon",""].map((h,i) => (
                    <th key={i} style={{
                      padding: i===0 ? "11px 16px 11px 22px" : "11px 12px",
                      textAlign:"left", fontSize:10.5, fontWeight:600,
                      color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
                      textTransform:"uppercase", letterSpacing:"0.07em",
                      whiteSpace:"nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const isLast = i === filtered.length - 1;
                  const urgent = !r.guide && r.opStatus !== "İptal" && r.opStatus !== "Tamamlandı";
                  return (
                    <tr key={r.id}
                      onMouseEnter={()=>setHov(true)}
                      onMouseLeave={()=>setHov(false)}
                      onClick={()=>onSelect&&onSelect(r.id)}
                      style={{
                        background:C.white,
                        cursor:"pointer", transition:"background .1s",
                        opacity: r.opStatus === "İptal" ? 0.65 : 1,
                      }}
                    >
                      {}
                      <td style={{ padding:"14px 16px 14px 22px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          {urgent && <span style={{ width:6, height:6, borderRadius:"50%", background:C.red, flexShrink:0 }}/>}
                          <span style={{
                            fontSize:12, fontWeight:600, color:C.navy,
                            fontFamily:"'DM Mono',monospace",
                            background:C.ivory, border:`1px solid ${C.borderLight}`,
                            padding:"3px 7px", borderRadius:5,
                          }}>{r.id}</span>
                        </div>
                      </td>
                      {}
                      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
                        <div style={{ fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{r.flag} {r.name}</div>
                        <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{r.country}</div>
                      </td>
                      {}
                      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle", maxWidth:180 }}>
                        <div style={{ fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif", fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.tour}</div>
                        <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{r.duration}</div>
                      </td>
                      {}
                      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
                        <div style={{ fontSize:13, fontWeight:600, color:C.navy, fontFamily:"'Playfair Display',serif" }}>{r.date}</div>
                        <div style={{ fontSize:12, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>⏰ {r.time}</div>
                      </td>
                      {}
                      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
                        <div style={{ display:"flex", alignItems:"center", gap:5, color:C.textMid }}>
                          <RIc d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" size={13} sw={1.5}/>
                          <span style={{ fontSize:13, fontWeight:500, fontFamily:"'DM Sans',sans-serif" }}>{r.pax}</span>
                        </div>
                      </td>
                      {}
                      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
                        <GuideChip name={r.guide}/>
                      </td>
                      {}
                      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
                        <RBadge label={r.payStatus} map={PAY_STATUS} small/>
                      </td>
                      {}
                      <td style={{ padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
                        <RBadge label={r.opStatus} map={RES_STATUS} small/>
                      </td>
                      {}
                      <td style={{ padding:"14px 16px 14px 8px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle" }}>
                        <div style={{ color:C.textFaint }}>
                          <RIc d="M9 18l6-6-6-6" size={14} sw={1.8}/>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
                <div className="rsp-cards"><MobileCardList items={filtered} renderCard={(res) => {
                  const rsm = RES_STATUS[res.opStatus]||{color:C.textMuted,bg:C.ivoryDark};
                  const rpm = PAY_STATUS_MAP[res.payStatus]||{color:C.textMuted,bg:C.ivoryDark};
                  return (
                    <MobileCard onClick={()=>onSelect&&onSelect(res.id)}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                        <div style={{fontSize:13.5,fontWeight:600,color:C.text,fontFamily:"'DM Sans',sans-serif"}}>{res.tour}</div>
                        <span style={{fontSize:11,padding:"2px 7px",borderRadius:99,color:rsm.color,background:rsm.bg,fontFamily:"'DM Sans',sans-serif",fontWeight:500,flexShrink:0}}>{res.opStatus}</span>
                      </div>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <span style={{fontSize:12,color:C.textFaint,fontFamily:"'DM Mono',monospace"}}>{res.id}</span>
                        <span style={{fontSize:12,color:C.textMuted,fontFamily:"'DM Sans',sans-serif"}}>{res.date} · {res.pax} kişi</span>
                        <span style={{fontSize:11,padding:"2px 7px",borderRadius:99,color:rpm.color,background:rpm.bg,fontFamily:"'DM Sans',sans-serif",fontWeight:500}}>{res.payStatus}</span>
                      </div>
                    </MobileCard>
                  );
                }}/></div>

            {}
            <div style={{
              padding:"11px 20px", background:C.ivory,
              borderTop:`1px solid ${C.borderLight}`,
              display:"flex", alignItems:"center", justifyContent:"space-between",
            }}>
              <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>
                {filtered.length} / {_allRes.length} rezervasyon
              </span>
            </div>
          </>
        )}
      </div>
      {showNewRes ? <NewReservationModal onClose={()=>setShowNewRes(false)} onSuccess={()=>{setShowNewRes(false);reloadRes&&reloadRes();}}/> : null}
    </div>
  );
}

function RCard({ children, style }) {
  return (
    <div style={{
      background:C.white, border:`1px solid ${C.border}`,
      borderRadius:12, overflow:"hidden", ...style,
    }}>{children}</div>
  );
}

function RCardHead({ title, accent, right }) {
  return (
    <div style={{
      padding:"13px 20px",
      background: accent ? `linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)` : C.ivory,
      borderBottom:`1px solid ${C.borderLight}`,
      display:"flex", alignItems:"center", justifyContent:"space-between",
    }}>
      <span style={{
        fontSize:11, fontWeight:600, letterSpacing:"0.09em",
        textTransform:"uppercase", fontFamily:"'DM Sans',sans-serif",
        color: accent ? "rgba(248,245,238,0.6)" : C.textFaint,
      }}>{title}</span>
      {right}
    </div>
  );
}

function RInfoRow({ label, value, mono, bold, alert, icon }) {
  return (
    <div style={{
      display:"flex", justifyContent:"space-between", alignItems:"flex-start",
      padding:"10px 20px", borderBottom:`1px solid ${C.borderLight}`,
    }}>
      <span style={{
        fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
        flexShrink:0, minWidth:130, paddingTop:1,
        display:"flex", alignItems:"center", gap:5,
      }}>
        {icon && <RIc d={icon} size={12} sw={1.5}/>}
        {label}
      </span>
      <span style={{
        fontSize: bold ? 15 : 13, fontWeight: bold ? 700 : 400,
        color: alert ? C.red : bold ? C.text : C.textMid,
        fontFamily: mono ? "'DM Mono',monospace" : bold ? "'Playfair Display',serif" : "'DM Sans',sans-serif",
        textAlign:"right",
      }}>{value || "—"}</span>
    </div>
  );
}

function StatusStepper({ current }) {
  const steps = ["Hazırlanıyor","Rehber Atandı","Hazır","Tamamlandı"];
  const cancelledIndex = -1;
  const currentIdx = steps.indexOf(current);
  const isCancelled = current === "İptal";

  return (
    <div style={{ padding:"16px 20px 20px" }}>
      {isCancelled ? (
        <div style={{
          padding:"12px 16px", borderRadius:8,
          background:C.redBg, border:`1px solid ${C.red}22`,
          display:"flex", alignItems:"center", gap:10,
          color:C.red, fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
        }}>
          <RIc d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" size={16} sw={1.8}/>
          Bu rezervasyon iptal edildi
        </div>
      ) : (
        <div style={{ position:"relative" }}>
          {}
          <div style={{
            position:"absolute", top:13, left:13, right:13, height:2,
            background:C.borderLight,
          }}>
            <div style={{
              width: currentIdx < 0 ? "0%" : `${(currentIdx/(steps.length-1))*100}%`,
              height:"100%", background:C.gold, transition:"width .4s",
            }}/>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", position:"relative", zIndex:1 }}>
            {steps.map((step, i) => {
              const done    = i < currentIdx;
              const active  = i === currentIdx;
              const pending = i > currentIdx;
              return (
                <div key={step} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, flex:1 }}>
                  <div style={{
                    width:26, height:26, borderRadius:"50%",
                    background: done ? C.gold : active ? C.navy : C.white,
                    border: done ? `2px solid ${C.gold}` : active ? `2px solid ${C.navy}` : `2px solid ${C.border}`,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    transition:"all .2s",
                  }}>
                    {done
                      ? <RIc d="M20 6L9 17l-5-5" size={13} sw={2.5} color="#fff"/>
                      : active
                        ? <span style={{ width:8, height:8, borderRadius:"50%", background:C.goldLight }}/>
                        : null
                    }
                  </div>
                  <span style={{
                    fontSize:10.5, fontWeight: active ? 600 : 400,
                    color: done ? C.gold : active ? C.navy : C.textFaint,
                    fontFamily:"'DM Sans',sans-serif",
                    textAlign:"center", lineHeight:1.3, whiteSpace:"nowrap",
                  }}>{step}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ResTimeline({ r }) {
  const opIdx = ["Hazırlanıyor","Rehber Atandı","Hazır","Tamamlandı"].indexOf(r.opStatus);
  const events = [
    { ...RES_TIMELINE_TEMPLATES[0], date:r.createdAt, time:"09:14", who:"Berk Çetinkaya", show:true },
    { ...RES_TIMELINE_TEMPLATES[1], date:"04 Haz 2026", time:"11:30", who:"Berk Çetinkaya", show: opIdx >= 1 || !!r.guide },
    { ...RES_TIMELINE_TEMPLATES[2], date:"05 Haz 2026", time:"16:00", who:"Berk Çetinkaya", show: opIdx >= 2 },
    { ...RES_TIMELINE_TEMPLATES[3], date:"06 Haz 2026", time:"10:15", who:"Sarah Johnson", show: opIdx >= 2 },
    { ...RES_TIMELINE_TEMPLATES[4], date:r.date,        time:"18:00", who:"Ahmet Yıldız",   show: opIdx >= 3 },
  ].filter(e => e.show);

  return (
    <div style={{ padding:"20px 20px 8px", position:"relative" }}>
      <div style={{
        position:"absolute", left:38, top:28, bottom:16,
        width:1, background:C.borderLight,
      }}/>
      {events.map((ev, i) => (
        <div key={i} style={{
          display:"flex", gap:16, alignItems:"flex-start",
          paddingBottom: i < events.length-1 ? 20 : 4,
        }}>
          <div style={{
            width:32, height:32, borderRadius:"50%", flexShrink:0,
            background: "#fff",
            border:`2px solid ${ev.dot}`,
            display:"flex", alignItems:"center", justifyContent:"center",
            color:ev.dot, position:"relative", zIndex:1,
          }}>
            <RIc d={ev.icon} size={13} sw={1.8} color={ev.dot}/>
          </div>
          <div style={{ flex:1, paddingTop:4 }}>
            <div style={{ display:"flex", alignItems:"baseline", gap:8, flexWrap:"wrap", marginBottom:3 }}>
              <span style={{
                fontSize:11, fontWeight:600, color:"#fff",
                background:ev.dot, padding:"1px 7px", borderRadius:4,
                fontFamily:"'DM Sans',sans-serif",
              }}>{ev.date}</span>
              <span style={{ fontSize:13, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{ev.action}</span>
              <span style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginLeft:"auto" }}>{ev.time}</span>
            </div>
            <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>— {ev.who}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

const RES_ACTIONS = [
  { label:"Rehber Ata",                      icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75", primary:true },
  { label:"Pickup Bilgisi Ekle",             icon:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z" },
  { label:"Ödeme Kaydı Ekle",               icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20" },
  { label:"Görev Oluştur",                   icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
  { label:"Hatırlatma Oluştur",             icon:"M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" },
  { label:"Turu Tamamlandı Olarak İşaretle", icon:"M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3", green:true },
];

function ResQuickActions({ res }) {
  const [opStatus, setOpStatus] = useState(res?.opStatus || "Hazırlanıyor");

  function handleOdemeEkle() {
    if (res) ActivityRepository.create({ entityType:"payment", entityId:res.id, action:"payment", description:`${res.id} için ödeme kaydı oluşturuldu` });
    if (NAV_REF.fn) NAV_REF.fn("/payments");
    else window.location.hash = "#/payments";
  }

  async function handleTamamlandi() {
    if (res) {
      const repo = getActiveRepo("reservation");
      await Promise.resolve(repo.update(res.id, { opStatus:"Tamamlandı" }));
      setOpStatus("Tamamlandı");
      Store.notify();
    }
  }

  return (
    <RCard>
      <RCardHead title="Hızlı İşlemler" accent/>
      <div style={{ padding:"12px" }}>
        {RES_ACTIONS.map((a, i) => {
          const isOdeme = a.label === "Ödeme Kaydı Ekle";
          const isTamamlandi = a.green;
          return (
            <button key={i}
              onMouseEnter={e=>e.currentTarget.style.background=C.ivory}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}
              onClick={isOdeme ? handleOdemeEkle : isTamamlandi ? handleTamamlandi : undefined}
              style={{
                display:"flex", alignItems:"center", gap:10,
                width:"100%", padding:"10px 12px",
                borderRadius:8, marginBottom: i < RES_ACTIONS.length-1 ? 6 : 0,
                border: a.primary ? "none" : a.green ? `1px solid ${C.green}44` : `1px solid ${C.border}`,
                background: a.primary ? C.navy : a.green ? C.greenBg : C.white,
                cursor:"pointer",
                color: a.primary ? C.white : a.green ? C.green : C.text,
                fontFamily:"'DM Sans',sans-serif", fontSize:13,
                fontWeight: a.primary ? 600 : 400,
                textAlign:"left", transition:"background .12s",
              }}>
              <RIc d={a.icon} size={14} sw={a.primary?2:1.6}/>
              {a.label}
            </button>
          );
        })}
      </div>
    </RCard>
  );
}

function ReservationDetailPage({ resId, onBack }) {
  const _sp = safeParam(resId);
  if (_sp.invalid) return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:60,gap:16}}>
      <div style={{fontSize:36}}>🔍</div>
      <div style={{fontSize:16,fontWeight:600,color:'#1B2D4F',fontFamily:"'Playfair Display',serif"}}>Kayıt bulunamadı</div>
      <div style={{fontSize:13,color:'#6B7280'}}>
        {_sp.reason==='demo' ? 'Bu demo kayıt Supabase modunda görüntülenemez.' : 'Geçersiz kayıt kimliği.'}
      </div>
      <button onClick={onBack} style={{padding:'9px 20px',borderRadius:8,border:'none',background:'#1B2D4F',color:'#fff',cursor:'pointer',fontSize:13}}>Geri Dön</button>
    </div>
  );

  const { data:_resRec, loading:resDetLoading, error:resDetError }
    = useRepo("reservation", "getById", resId);
  if (resDetLoading) return <LoadingState label="Rezervasyon yükleniyor…"/>;
  if (resDetError)   return <ErrorState message={resDetError} onRetry={()=>{}}/>;
  if (!_resRec)      return <NotFoundCard entityType="Rezervasyon" entityId={resId} onBack={onBack}/>;
  const r = _resRec;
  const sm = RES_STATUS[r.opStatus] || {};
  const pm = PAY_STATUS[r.payStatus] || {};
  const sym = r.currency === "TRY" ? "₺" : "€";
  const paidPct = safePctNum(r.total - r.remaining, r.total);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

      {}
      <div style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"15px 22px",
        display:"flex", alignItems:"center", justifyContent:"space-between", gap:16,
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <button onClick={onBack} style={{
            display:"flex", alignItems:"center", gap:6,
            background:C.ivory, border:`1px solid ${C.border}`,
            borderRadius:7, padding:"6px 12px", cursor:"pointer",
            color:C.textMid, fontFamily:"'DM Sans',sans-serif", fontSize:12.5,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.ivoryDark}
            onMouseLeave={e=>e.currentTarget.style.background=C.ivory}
          >
            <RIc d="M15 18l-6-6 6-6" size={13} sw={2}/>
            Rezervasyonlar
          </button>
          <div style={{ width:1, height:20, background:C.borderLight }}/>
          <span style={{
            fontSize:12, color:C.textFaint, fontFamily:"'DM Mono',monospace",
            background:C.ivory, border:`1px solid ${C.borderLight}`,
            padding:"3px 8px", borderRadius:5,
          }}>{r.id}</span>
          <div>
            <div style={{ fontSize:17, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", lineHeight:1.2 }}>
              {r.flag} {r.name}
            </div>
            <div style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>
              {r.tour} · {r.date} · {r.time}
            </div>
          </div>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          <RBadge label={r.payStatus} map={PAY_STATUS}/>
          <div style={{ width:1, height:20, background:C.borderLight }}/>
          <RBadge label={r.opStatus} map={RES_STATUS}/>
          <button style={{
            display:"flex", alignItems:"center", gap:6,
            padding:"7px 14px", borderRadius:7,
            border:`1.5px solid ${C.gold}`, background:C.goldPale,
            cursor:"pointer", color:C.gold,
            fontFamily:"'DM Sans',sans-serif", fontSize:12.5, fontWeight:500,
          }}>
            <RIc d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" size={13} sw={1.8}/>
            Düzenle
          </button>
        </div>
      </div>

      {}
      <div className="rsp-split" style={{ display:"grid", gridTemplateColumns:"1fr 1fr 272px", gap:18, alignItems:"start" }}>

        {}
        <div style={{ display:"flex", flexDirection:"column", gap:18 }}>

          {}
          <RCard>
            <RCardHead title="Misafir Bilgileri"/>
            <RInfoRow label="Ad Soyad" value={`${r.flag} ${r.name}`} bold/>
            <RInfoRow label="Telefon"  value={r.phone} mono icon="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.09-1.09a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
            <RInfoRow label="E-posta"  value={r.email} mono icon="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6"/>
            <div style={{ padding:"10px 20px", display:"flex", gap:8, alignItems:"center" }}>
              <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", minWidth:130 }}>Ülke</span>
              <span style={{ fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif" }}>{r.flag} {r.country}</span>
            </div>
          </RCard>

          {}
          <RCard>
            <RCardHead title="Tur Bilgileri"/>
            {}
            <div style={{
              margin:"16px 16px 0", padding:"14px 16px",
              background:C.navy, borderRadius:10, marginBottom:0,
            }}>
              <div style={{ fontSize:15, fontWeight:700, color:C.ivory, fontFamily:"'Playfair Display',serif", lineHeight:1.3 }}>{r.tour}</div>
              <div style={{ fontSize:12, color:"rgba(248,245,238,0.55)", fontFamily:"'DM Sans',sans-serif", marginTop:4 }}>{r.date} · {r.time} · {r.duration}</div>
            </div>
            <div style={{ height:10 }}/>
            <RInfoRow label="Tarih"       value={r.date} icon="M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z"/>
            <RInfoRow label="Saat"        value={r.time} icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            <RInfoRow label="Süre"        value={r.duration}/>
            <div style={{ padding:"10px 20px", display:"flex", gap:8, alignItems:"center", borderBottom:`1px solid ${C.borderLight}` }}>
              <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", minWidth:130, display:"flex", alignItems:"center", gap:5 }}>
                <RIc d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" size={12} sw={1.5}/>
                Kişi Sayısı
              </span>
              <span style={{ fontSize:14, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>{r.pax} Kişi</span>
            </div>
          </RCard>

          {}
          <RCard>
            <RCardHead title="Ödeme Özeti"/>
            <div style={{ padding:"14px 20px 0" }}>
              {}
              <div style={{
                display:"flex", alignItems:"baseline", gap:8, marginBottom:14,
                paddingBottom:14, borderBottom:`1px solid ${C.borderLight}`,
              }}>
                <span style={{ fontSize:32, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>{sym}{r.fmtNum(total)}</span>
                <span style={{ fontSize:13, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{r.currency}</span>
              </div>
              {}
              <div style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Ödeme İlerlemesi</span>
                  <span style={{ fontSize:12, fontWeight:600, color:C.gold, fontFamily:"'DM Sans',sans-serif" }}>%{paidPct}</span>
                </div>
                <div style={{ height:6, background:C.ivoryDark, borderRadius:99, overflow:"hidden" }}>
                  <div style={{ width:`${paidPct}%`, height:"100%", background:C.gold, borderRadius:99, transition:"width .4s" }}/>
                </div>
              </div>
            </div>
            {[
              { label:"Kapora", val:`${sym}${r.fmtNum(deposit)}`, color:C.amber },
              { label:"Kalan Ödeme", val:`${sym}${r.fmtNum(remaining)}`, color: r.remaining > 0 ? C.red : C.green, alert: r.remaining > 0 },
              { label:"Ödeme Durumu", val:null, badge:r.payStatus },
            ].map((row, i, arr) => (
              <div key={i} style={{
                display:"flex", justifyContent:"space-between", alignItems:"center",
                padding:"10px 20px",
                borderTop:`1px solid ${C.borderLight}`,
              }}>
                <span style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>{row.label}</span>
                {row.badge
                  ? <RBadge label={row.badge} map={PAY_STATUS} small/>
                  : <span style={{ fontSize:15, fontWeight:700, color:row.color, fontFamily:"'Playfair Display',serif" }}>{row.val}</span>
                }
              </div>
            ))}
          </RCard>
        </div>

        {}
        <div style={{ display:"flex", flexDirection:"column", gap:18 }}>

          {}
          <RCard>
            <RCardHead title="Rezervasyon Durumu"/>
            <StatusStepper current={r.opStatus}/>
          </RCard>

          {}
          <RCard>
            <RCardHead title="Operasyon Bilgileri"
              right={
                <span style={{
                  fontSize:10.5, color:C.goldLight,
                  fontFamily:"'DM Sans',sans-serif", fontWeight:500,
                }}>Operasyon Merkezi</span>
              }
            />
            <RInfoRow label="Pickup Lokasyonu" value={r.pickup}    icon="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z"/>
            <RInfoRow label="Pickup Saati"     value={r.pickupTime} icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            {}
            <div style={{ padding:"10px 20px", borderBottom:`1px solid ${C.borderLight}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:5 }}>
                <RIc d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" size={12} sw={1.5}/>
                Rehber
              </span>
              <GuideChip name={r.guide}/>
            </div>
            <RInfoRow label="Araç"   value={r.vehicle} icon="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z M13 17H9m4 0h2m2-5H3M5 12V5h14v7"/>
            <RInfoRow label="Şoför"  value={r.driver}/>
            {}
            {r.opNotes && (
              <div style={{ padding:"12px 20px" }}>
                <div style={{ fontSize:10.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:6 }}>Operasyon Notları</div>
                <div style={{
                  fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif",
                  background:C.ivory, borderRadius:8, padding:"10px 12px",
                  border:`1px solid ${C.borderLight}`, lineHeight:1.65,
                }}>{r.opNotes}</div>
              </div>
            )}
          </RCard>

          {}
          <RCard>
            <RCardHead title="Aktivite Zaman Çizelgesi"/>
            <ResTimeline r={r}/>
          </RCard>
        </div>

        {}
        <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
          <ResQuickActions res={r}/>

          {}
          <RCard>
            <RCardHead title="Rezervasyon Bilgileri"/>
            <div style={{ padding:"4px 0" }}>
              {[
                { label:"Oluşturulma",    val:r.createdAt,          type:null },
                { label:"Bağlı Talep",    val:r.leadId,             type:"lead" },
                { label:"Bağlı Teklif",   val:r.quoteId || null,    type:"quote" },
                { label:"Para Birimi",    val:r.currency,           type:null },
              ].map((row,i) => (
                <div key={i} style={{
                  display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"10px 18px", borderBottom:`1px solid ${C.borderLight}`,
                }}>
                  <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{row.label}</span>
                  {row.type ? <IDLink id={row.val} type={row.type}/> : <span style={{ fontSize:12.5, color:C.text, fontFamily:"'DM Mono',monospace", fontWeight:500 }}>{row.val || "—"}</span>}
                </div>
              ))}
            </div>
          </RCard>

          {}
          {!r.guide && r.opStatus !== "İptal" && (
            <div style={{
              background:C.redBg, border:`1px solid ${C.red}22`,
              borderRadius:12, padding:"14px 16px",
              display:"flex", gap:10, alignItems:"flex-start",
            }}>
              <div style={{
                width:32, height:32, borderRadius:8, flexShrink:0,
                background:"rgba(192,57,43,0.12)",
                display:"flex", alignItems:"center", justifyContent:"center", color:C.red,
              }}>
                <RIc d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" size={16} sw={1.8}/>
              </div>
              <div>
                <div style={{ fontSize:12.5, fontWeight:600, color:C.red, fontFamily:"'DM Sans',sans-serif", marginBottom:3 }}>Rehber Atanmadı</div>
                <div style={{ fontSize:12, color:"#9B3A2F", fontFamily:"'DM Sans',sans-serif", lineHeight:1.5 }}>
                  Bu tur için henüz rehber atanmadı. Tur tarihinden önce atama yapılmalı.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const CAL_TODAY = new Date(); // real current date — was hardcoded to a fixed demo date

const CAL_OP_COLOR = {
  "Hazırlanıyor":  { border:"#6B3FA0", bg:"#F3EEF9", text:"#6B3FA0", stripe:"rgba(107,63,160,0.08)" },
  "Rehber Atandı": { border:"#1A6FAE", bg:"#EBF4FC", text:"#1A6FAE", stripe:"rgba(26,111,174,0.08)" },
  "Hazır":         { border:"#B8973A", bg:"#FDF8EC", text:"#B8973A", stripe:"rgba(184,151,58,0.08)" },
  "Tamamlandı":    { border:"#2E7D52", bg:"#EBF5EF", text:"#2E7D52", stripe:"rgba(46,125,82,0.08)"  },
  "İptal":         { border:"#C0392B", bg:"#FDECEC", text:"#C0392B", stripe:"rgba(192,57,43,0.08)"  },
};

function CIc({ d, size=14, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function fmtHHMM(date) {
  return date.toLocaleTimeString("tr-TR", { hour:"2-digit", minute:"2-digit" });
}

function fmtDayShort(date) {
  return date.toLocaleDateString("tr-TR", { weekday:"short" });
}

function fmtDayNum(date) {
  return date.getDate();
}

function fmtMonthYear(date) {
  return date.toLocaleDateString("tr-TR", { month:"long", year:"numeric" });
}

function isSameDay(a, b) {
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

function isToday(d) { return isSameDay(d, CAL_TODAY); }

function EventCard({ ev, compact }) {
  const [hov, setHov] = useState(false);
  const col = CAL_OP_COLOR[ev.opStatus] || CAL_OP_COLOR["Hazırlanıyor"];
  const noGuide  = !ev.guideOk;
  const noPay    = ev.payStatus === "Ödeme Bekliyor";
  const noPickup = !ev.pickup;

  return (
    <div
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        background:C.white,
        border:`1.5px solid ${col.border}`,
        borderLeft:`4px solid ${col.border}`,
        borderRadius:8,
        padding: compact ? "7px 10px" : "10px 12px",
        cursor:"pointer",
        transition:"background .12s, box-shadow .12s",
        boxShadow: hov ? `0 2px 8px rgba(27,45,79,0.28)` : "0 1px 3px rgba(0,0,0,0.06)",
        position:"relative",
        overflow:"hidden",
      }}
    >
      {}
      {(noGuide || noPay) && (
        <div style={{
          position:"absolute", top:7, right:8,
          display:"flex", gap:3,
        }}>
          {noGuide && <span style={{ width:7, height:7, borderRadius:"50%", background:C.red }}/>}
          {noPay   && <span style={{ width:7, height:7, borderRadius:"50%", background:C.amber }}/>}
        </div>
      )}

      {}
      <div style={{
        fontSize:10.5, fontWeight:700, color:col.text,
        fontFamily:"'DM Mono',monospace", marginBottom: compact ? 3 : 5,
        letterSpacing:"0.04em",
      }}>
        {fmtHHMM(ev.date)}
        {!compact && <span style={{ fontWeight:400, opacity:0.65 }}> – {ev.endHour}:00</span>}
      </div>

      {}
      <div style={{
        fontSize: compact ? 11.5 : 13, fontWeight:600, color:C.text,
        fontFamily:"'DM Sans',sans-serif", lineHeight:1.2,
        marginBottom: compact ? 2 : 4,
        whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
      }}>
        {ev.flag} {ev.guest}
      </div>

      {!compact && (
        <>
          {}
          <div style={{
            fontSize:11.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif",
            marginBottom:6, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          }}>{ev.tour}</div>

          {}
          <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:5 }}>
            <span style={{
              fontSize:10.5, padding:"2px 6px", borderRadius:4,
              background:"rgba(27,45,79,0.08)", color:C.navy,
              fontFamily:"'DM Sans',sans-serif",
            }}>{ev.pax} kişi</span>
            <span style={{
              fontSize:10.5, padding:"2px 6px", borderRadius:4,
              background: ev.payStatus==="Ödendi" ? C.greenBg : ev.payStatus==="Kapora Ödendi" ? C.goldPale : C.redBg,
              color: ev.payStatus==="Ödendi" ? C.green : ev.payStatus==="Kapora Ödendi" ? C.gold : C.red,
              fontFamily:"'DM Sans',sans-serif",
            }}>{ev.payStatus}</span>
          </div>

          {}
          <div style={{
            display:"flex", alignItems:"center", gap:5,
            fontSize:11, color: ev.guideOk ? C.textMuted : C.red,
            fontFamily:"'DM Sans',sans-serif",
          }}>
            <CIc d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" size={11} sw={1.5} color={ev.guideOk ? C.textFaint : C.red}/>
            {ev.guideOk ? ev.guide : "Rehber atanmadı"}
          </div>
        </>
      )}

      {compact && (
        <div style={{
          fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        }}>{ev.tour}</div>
      )}
    </div>
  );
}

function CalSidebar({ todayEvents, weekEvents }) {
  const noGuide   = weekEvents.filter(e => !e.guideOk && e.opStatus !== "Tamamlandı");
  const noPay     = weekEvents.filter(e => e.payStatus === "Ödeme Bekliyor");
  const noPickup  = weekEvents.filter(e => !e.pickup && e.opStatus !== "Tamamlandı");

  function SideSection({ title, items, emptyMsg, color, icon }) {
    return (
      <div style={{ marginBottom:20 }}>
        <div style={{
          fontSize:10.5, fontWeight:600, color:C.textFaint,
          textTransform:"uppercase", letterSpacing:"0.09em",
          fontFamily:"'DM Sans',sans-serif",
          display:"flex", alignItems:"center", gap:6, marginBottom:10,
        }}>
          <CIc d={icon} size={13} sw={1.6} color={color}/>
          {title}
          {items.length > 0 && (
            <span style={{
              marginLeft:"auto", fontSize:11, fontWeight:700,
              color:C.white, background:color,
              width:18, height:18, borderRadius:"50%",
              display:"inline-flex", alignItems:"center", justifyContent:"center",
            }}>{items.length}</span>
          )}
        </div>
        {items.length === 0 ? (
          <div style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontStyle:"italic", paddingLeft:4 }}>
            {emptyMsg}
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {items.map((ev,i) => (
              <div key={i} style={{
                padding:"9px 12px", borderRadius:8,
                background:C.ivory, border:`1px solid ${C.borderLight}`,
                cursor:"pointer",
              }}>
                <div style={{ fontSize:12.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif", marginBottom:2 }}>
                  {ev.flag} {ev.guest}
                </div>
                <div style={{ fontSize:11.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>
                  {fmtHHMM(ev.date)} · {ev.tour.length > 22 ? ev.tour.slice(0,22)+"…" : ev.tour}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{
      background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
      overflow:"hidden", position:"sticky", top:20,
    }}>
      {}
      <div style={{
        background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
        padding:"16px 18px",
      }}>
        <div style={{ fontSize:13.5, fontWeight:600, color:C.ivory, fontFamily:"'Playfair Display',serif" }}>
          Operasyon Özeti
        </div>
        <div style={{ fontSize:11.5, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Sans',sans-serif", marginTop:3 }}>
          Bu haftaki tur planı
        </div>
      </div>

      {}
      <div style={{ padding:"16px 16px 4px" }}>
        <div style={{
          fontSize:10.5, fontWeight:600, color:C.textFaint,
          textTransform:"uppercase", letterSpacing:"0.09em",
          fontFamily:"'DM Sans',sans-serif", marginBottom:10,
          display:"flex", alignItems:"center", justifyContent:"space-between",
        }}>
          <span>Bugünkü Turlar</span>
          <span style={{
            fontSize:11, fontWeight:700, color:C.white,
            background:C.navy, padding:"1px 7px", borderRadius:10,
          }}>{todayEvents.length}</span>
        </div>
        {todayEvents.length === 0 ? (
          <div style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontStyle:"italic", marginBottom:14 }}>
            Bugün tur planlanmamış.
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:14 }}>
            {todayEvents.map((ev,i) => (
              <div key={i} style={{
                padding:"9px 12px", borderRadius:8,
                background:C.ivory, border:`1px solid ${C.borderLight}`,
                display:"flex", alignItems:"center", gap:10,
              }}>
                <div style={{
                  width:36, height:36, borderRadius:8, flexShrink:0,
                  background:C.navy,
                  display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                }}>
                  <span style={{ fontSize:11, fontWeight:700, color:C.white, lineHeight:1, fontFamily:"'DM Mono',monospace" }}>
                    {fmtHHMM(ev.date).split(":")[0]}
                  </span>
                  <span style={{ fontSize:8, color:C.goldLight, lineHeight:1, fontFamily:"'DM Mono',monospace" }}>
                    :{fmtHHMM(ev.date).split(":")[1]}
                  </span>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {ev.flag} {ev.guest}
                  </div>
                  <div style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:1 }}>
                    {ev.pax} kişi · {ev.guideOk ? ev.guide : <span style={{color:C.red}}>Rehber yok</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ height:1, background:C.borderLight, marginBottom:16 }}/>

        <SideSection
          title="Rehber Atanmayanlar"
          items={noGuide} emptyMsg="Tüm turlara rehber atandı ✓"
          color={C.red}
          icon="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75"
        />

        <SideSection
          title="Ödeme Bekleyenler"
          items={noPay} emptyMsg="Bekleyen ödeme yok ✓"
          color={C.amber}
          icon="M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20"
        />

        <SideSection
          title="Pickup Eksik"
          items={noPickup} emptyMsg="Tüm pickup bilgileri eksiksiz ✓"
          color={"#6B3FA0"}
          icon="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z"
        />
      </div>
    </div>
  );
}

function WeeklyView({ weekStart, events }) {
  const days = Array.from({length:7}, (_,i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  const TR_DAYS = ["Pzt","Sal","Çar","Per","Cum","Cmt","Paz"];

  return (
    <div style={{
      display:"grid",
      gridTemplateColumns: "52px repeat(7, minmax(0, 1fr))",
      background:C.white,
      border:`1px solid ${C.border}`,
      borderRadius:12,
      overflow:"hidden",
    }}>
      {}
      <div style={{ background:C.ivory, borderBottom:`1px solid ${C.border}` }}/>
      {days.map((day, i) => {
        const today = isToday(day);
        const dayEvents = events.filter(e => isSameDay(e.date, day));
        return (
          <div key={i} style={{
            background: today ? C.goldPale : C.ivory,
            borderBottom:`1px solid ${C.border}`,
            borderLeft:`1px solid ${C.borderLight}`,
            padding:"10px 8px 8px",
            textAlign:"center",
          }}>
            <div style={{
              fontSize:10.5, color: today ? C.gold : C.textFaint,
              fontFamily:"'DM Sans',sans-serif",
              textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:4,
              fontWeight: today ? 600 : 400,
            }}>{TR_DAYS[i]}</div>
            <div style={{
              width:32, height:32, borderRadius:"50%", margin:"0 auto",
              background: today ? C.gold : "transparent",
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>
              <span style={{
                fontSize:16, fontWeight:700,
                color: today ? C.white : C.text,
                fontFamily:"'Playfair Display',serif",
              }}>{fmtDayNum(day)}</span>
            </div>
            {dayEvents.length > 0 && (
              <div style={{
                fontSize:10, color: today ? C.gold : C.textFaint,
                fontFamily:"'DM Sans',sans-serif", marginTop:4,
              }}>{dayEvents.length} tur</div>
            )}
          </div>
        );
      })}

      {}
      {Array.from({length:16}, (_,row) => {
        const hour = row + 7;
        const isHour = true;
        return [
          <div key={`t-${row}`} style={{
            padding:"0 8px",
            height:64,
            borderBottom:`1px solid ${C.borderLight}`,
            display:"flex", alignItems:"flex-start", paddingTop:8,
            background: hour % 2 === 0 ? "rgba(248,245,238,0.3)" : "transparent",
          }}>
            <span style={{
              fontSize:10, color:C.textFaint,
              fontFamily:"'DM Mono',monospace",
              whiteSpace:"nowrap",
            }}>{String(hour).padStart(2,"0")}:00</span>
          </div>,

          ...days.map((day, ci) => {
            const slotEvents = events.filter(e => {
              if (!isSameDay(e.date, day)) return false;
              const eHour = e.date.getHours();
              return eHour === hour;
            });

            return (
              <div key={`${row}-${ci}`} style={{
                height:64,
                borderBottom:`1px solid ${C.borderLight}`,
                borderLeft:`1px solid ${C.borderLight}`,
                padding:"3px 4px",
                background: hour % 2 === 0 ? "rgba(248,245,238,0.15)" : "transparent",
                verticalAlign:"top",
                position:"relative",
              }}>
                {slotEvents.map((ev, ei) => (
                  <EventCard key={ei} ev={ev} compact/>
                ))}
              </div>
            );
          }),
        ];
      }).flat()}
    </div>
  );
}

function DailyView({ date, events }) {
  const dayEvents = events.filter(e => isSameDay(e.date, date));
  const hours = Array.from({length:16}, (_,i)=>i+7);

  return (
    <div style={{
      display:"grid", gridTemplateColumns:"52px minmax(0, 1fr)",
      background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden",
    }}>
      {}
      <div style={{ background:C.ivory, borderBottom:`1px solid ${C.border}`, padding:"16px 8px", textAlign:"center" }}>
        <div style={{ fontSize:10, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em" }}>Saat</div>
      </div>
      <div style={{
        background: isToday(date) ? C.goldPale : C.ivory,
        borderBottom:`1px solid ${C.border}`,
        borderLeft:`1px solid ${C.borderLight}`,
        padding:"10px 16px",
      }}>
        <div style={{ fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>
          {date.toLocaleDateString("tr-TR",{weekday:"long", day:"numeric", month:"long", year:"numeric"})}
        </div>
        <div style={{ fontSize:13, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>
          {dayEvents.length} tur planlandı
        </div>
      </div>

      {hours.map(hour => {
        const slotEvents = dayEvents.filter(e => e.date.getHours() === hour);
        return [
          <div key={`t${hour}`} style={{
            padding:"0 8px", height:80,
            borderBottom:`1px solid ${C.borderLight}`,
            display:"flex", alignItems:"flex-start", paddingTop:10,
            background: hour % 2 === 0 ? "rgba(248,245,238,0.3)" : "transparent",
          }}>
            <span style={{ fontSize:10.5, color:C.textFaint, fontFamily:"'DM Mono',monospace" }}>{String(hour).padStart(2,"0")}:00</span>
          </div>,
          <div key={`s${hour}`} style={{
            height:80, borderBottom:`1px solid ${C.borderLight}`,
            borderLeft:`1px solid ${C.borderLight}`,
            padding:"4px 8px",
            background: hour % 2 === 0 ? "rgba(248,245,238,0.1)" : "transparent",
            display:"flex", gap:8, flexWrap:"wrap", alignContent:"flex-start",
          }}>
            {slotEvents.map((ev,i) => (
              <div key={i} style={{ width:"calc(50% - 4px)", maxWidth:380 }}>
                <EventCard ev={ev} compact={false}/>
              </div>
            ))}
          </div>,
        ];
      }).flat()}
    </div>
  );
}

function MonthlyView({ monthStart, events, onSelectDay, isMobile }) {
  const firstDay = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0
  const gridStart = new Date(firstDay);
  gridStart.setDate(gridStart.getDate() - startOffset);

  const cells = Array.from({length:42}, (_,i) => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  const TR_DAYS_FULL = ["Pzt","Sal","Çar","Per","Cum","Cmt","Paz"];
  const inMonth = d => d.getMonth() === monthStart.getMonth();

  return (
    <div style={{
      background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden",
    }}>
      {}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7, minmax(0, 1fr))", borderBottom:`1px solid ${C.border}` }}>
        {TR_DAYS_FULL.map(d => (
          <div key={d} style={{
            padding:"10px 0", textAlign:"center",
            fontSize:10.5, fontWeight:600, color:C.textFaint,
            fontFamily:"'DM Sans',sans-serif",
            textTransform:"uppercase", letterSpacing:"0.07em",
            background:C.ivory,
            borderLeft:`1px solid ${C.borderLight}`,
          }}>{d}</div>
        ))}
      </div>

      {}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7, minmax(0, 1fr))" }}>
        {cells.map((cell,i) => {
          const cellEvents = events.filter(e => isSameDay(e.date, cell));
          const today = isToday(cell);
          const inMo  = inMonth(cell);
          return (
            <div key={i}
              onClick={() => onSelectDay && onSelectDay(cell)}
              style={{
                minHeight: isMobile ? 46 : 100,
                borderRight: (i+1)%7===0 ? "none" : `1px solid ${C.borderLight}`,
                borderBottom: i < 35 ? `1px solid ${C.borderLight}` : "none",
                padding: isMobile ? "4px 2px" : "6px 6px 4px",
                background: today ? C.goldPale : !inMo ? "rgba(240,235,225,0.4)" : C.white,
                cursor: onSelectDay ? "pointer" : "default",
                display: isMobile ? "flex" : "block",
                flexDirection: isMobile ? "column" : undefined,
                alignItems: isMobile ? "center" : undefined,
                gap: isMobile ? 3 : 0,
              }}>
              {}
              <div style={{ marginBottom: isMobile ? 0 : 4 }}>
                <span style={{
                  display:"inline-flex", alignItems:"center", justifyContent:"center",
                  width:22, height:22, borderRadius:"50%",
                  background: today ? C.gold : "transparent",
                  fontSize:12, fontWeight: today ? 700 : inMo ? 500 : 400,
                  color: today ? C.white : inMo ? C.text : C.textFaint,
                  fontFamily:"'DM Sans',sans-serif",
                }}>{fmtDayNum(cell)}</span>
              </div>
              {isMobile ? (
                cellEvents.length > 0 && (
                  <div style={{ display:"flex", gap:2, flexWrap:"wrap", justifyContent:"center" }}>
                    {cellEvents.slice(0,3).map((ev,ei) => {
                      const col = CAL_OP_COLOR[ev.opStatus] || CAL_OP_COLOR["Hazırlanıyor"];
                      return <span key={ei} style={{ width:5, height:5, borderRadius:"50%", background:col.border }}/>;
                    })}
                  </div>
                )
              ) : (
                <>
                  {cellEvents.slice(0,2).map((ev,ei) => {
                    const col = CAL_OP_COLOR[ev.opStatus] || CAL_OP_COLOR["Hazırlanıyor"];
                    return (
                      <div key={ei} style={{
                        padding:"2px 5px", borderRadius:4, marginBottom:2,
                        background:col.bg, borderLeft:`3px solid ${col.border}`,
                        fontSize:10.5, color:col.text,
                        fontFamily:"'DM Sans',sans-serif",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                        cursor:"pointer",
                      }}>
                        {fmtHHMM(ev.date).slice(0,5)} {ev.flag} {ev.guest.split(" ")[0]}
                      </div>
                    );
                  })}
                  {cellEvents.length > 2 && (
                    <div style={{
                      fontSize:10.5, color:C.textFaint,
                      fontFamily:"'DM Sans',sans-serif", paddingLeft:2,
                    }}>+{cellEvents.length-2} daha</div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Mobile calendar primary view: a vertical agenda of one day's tours.
   Replaces the desktop hourly grid, which does not fit a phone screen. */
function MobileAgendaView({ date, events }) {
  const dayEvents = events
    .filter(e => isSameDay(e.date, date))
    .sort((a,b) => a.date - b.date);

  if (dayEvents.length === 0) {
    return (
      <div style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"48px 24px", textAlign:"center",
      }}>
        <div style={{ fontSize:32, marginBottom:12, opacity:.25 }}>🗓</div>
        <div style={{ fontSize:14.5, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:4 }}>
          Bu gün için planlanmış tur yok.
        </div>
        <div style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>
          Başka bir gün seçin veya yeni rezervasyon ekleyin.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {dayEvents.map((ev,i) => (
        <EventCard key={ev.id||i} ev={ev} compact={false}/>
      ))}
    </div>
  );
}

/* Shared by CalendarPage (desktop) and MobileCalendarPage (mobile agenda):
   builds calendar events from the real reservations repo. Extracted so
   both surfaces read the exact same data/business logic — only
   presentation differs. */
function useCalendarEvents() {
  const { data:calReservations } = useRepo("reservation", "getAll");
  // Always derived from the real reservations repo (mock array in Mock mode,
  // Supabase rows in production) — never a separate hardcoded event list, so
  // an empty/loading result correctly renders as an empty calendar rather
  // than fabricated tours.
  return (calReservations || []).map(r => {
    const raw = r.checkIn || r.travelStart || r.check_in || r.date || null;
    if (!raw) return null;
    try {
      const dateObj = new Date(raw + (raw.includes('T') ? '' : 'T09:00:00'));
      if (isNaN(dateObj.getTime())) return null;
      const guideName = r.guide || r.guideName || null;
      return {
        id:      r.id,
        date:    dateObj,
        endHour: Math.min((dateObj.getHours() || 9) + parseInt(r.duration || 4), 22),
        guest:   r.name || r.customer || r.contactName || '—',
        flag:    r.flag || '🏳',
        pax:     parseInt(r.pax || r.paxAdult || 1),
        tour:    r.tour || r.destination || '—',
        guide:   guideName,
        guideOk: !!guideName,
        payStatus: r.payStatus || null,
        pickup:  r.pickup || r.pickupLocation || null,
        opStatus: r.opStatus || null,
        color:   '#1B2D4F',
      };
    } catch(_) { return null; }
  }).filter(Boolean);
}

function CalendarPage() {
  const { isMobile } = useBreakpoint();
  // Mobile never opens on the desktop weekly grid (Phase 9).
  const [view, setView]         = useState(() => isMobile ? "daily" : "weekly");   // "daily" | "weekly" | "monthly"
  const [weekOffset, setWeekOffset] = useState(0);
  const [dayOffset, setDayOffset]   = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const CAL_EVENTS_LIVE = useCalendarEvents();

  const currentDay = new Date(CAL_TODAY);
  currentDay.setDate(currentDay.getDate() + dayOffset);

  const weekStart = new Date(CAL_TODAY);
  const dow = (CAL_TODAY.getDay() + 6) % 7; // Mon=0
  weekStart.setDate(CAL_TODAY.getDate() - dow + weekOffset * 7);

  const monthStart = new Date(CAL_TODAY.getFullYear(), CAL_TODAY.getMonth() + monthOffset, 1);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const visibleEvents = view === "daily"
    ? CAL_EVENTS_LIVE.filter(e => isSameDay(e.date, currentDay))
    : view === "weekly"
      ? CAL_EVENTS_LIVE.filter(e => {
          const d = new Date(e.date); d.setHours(0,0,0,0);
          const ws = new Date(weekStart); ws.setHours(0,0,0,0);
          const we = new Date(weekEnd); we.setHours(23,59,59,0);
          return d >= ws && d <= we;
        })
      : CAL_EVENTS_LIVE.filter(e => e.date.getMonth() === monthStart.getMonth() && e.date.getFullYear() === monthStart.getFullYear());

  const todayEvents = CAL_EVENTS_LIVE.filter(e => isSameDay(e.date, CAL_TODAY));

  // On mobile the weekly grid is never rendered (Phase 9) — treat a
  // lingering "weekly" state as "daily" for the header/nav too, so the
  // label and prev/next controls always match what's actually on screen.
  const effectiveView = (isMobile && view === "weekly") ? "daily" : view;

  function navLabel() {
    if (effectiveView === "daily") {
      return currentDay.toLocaleDateString("tr-TR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
    }
    if (effectiveView === "weekly") {
      const ws = weekStart.toLocaleDateString("tr-TR",{day:"numeric",month:"short"});
      const we = weekEnd.toLocaleDateString("tr-TR",{day:"numeric",month:"short",year:"numeric"});
      return `${ws} – ${we}`;
    }
    return monthStart.toLocaleDateString("tr-TR",{month:"long",year:"numeric"});
  }

  function goBack()    { effectiveView==="daily"?setDayOffset(o=>o-1):effectiveView==="weekly"?setWeekOffset(o=>o-1):setMonthOffset(o=>o-1); }
  function goForward() { effectiveView==="daily"?setDayOffset(o=>o+1):effectiveView==="weekly"?setWeekOffset(o=>o+1):setMonthOffset(o=>o+1); }
  function goToday()   { setDayOffset(0); setWeekOffset(0); setMonthOffset(0); }

  const mobileViewTabs = [{k:"daily",l:"Gün"},{k:"monthly",l:"Ay"}];
  const desktopViewTabs = [{k:"daily",l:"Günlük"},{k:"weekly",l:"Haftalık"},{k:"monthly",l:"Aylık"}];

  function selectDayFromMonth(d) {
    const diff = Math.round((new Date(d.getFullYear(),d.getMonth(),d.getDate()) - new Date(CAL_TODAY.getFullYear(),CAL_TODAY.getMonth(),CAL_TODAY.getDate())) / 86400000);
    setDayOffset(diff);
    setView("daily");
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

      {}
      <div style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding: isMobile ? "16px" : "20px 24px",
        display:"flex", flexDirection: isMobile ? "column" : "row",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent:"space-between", gap: isMobile ? 14 : 16,
      }}>
        <div>
          <h1 style={{ margin:0, fontSize: isMobile ? 20 : 24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:4 }}>Takvim</h1>
          {!isMobile && (
            <p style={{ margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>
              Yaklaşan turları, rezervasyonları ve operasyon planını takvim üzerinden takip edin.
            </p>
          )}
        </div>

        {}
        <div style={{
          display:"flex", flexDirection: isMobile ? "column" : "row",
          alignItems:"center", gap:10, flexShrink:0,
        }}>
          {}
          <div style={{ display:"flex", alignItems:"center", gap:10, width: isMobile ? "100%" : "auto" }}>
            <button onClick={goToday} style={{
              padding: isMobile ? "9px 12px" : "7px 14px", borderRadius:7,
              border:`1px solid ${C.border}`, background:C.ivory,
              cursor:"pointer", color:C.text, flexShrink:0,
              fontFamily:"'DM Sans',sans-serif", fontSize:12.5, fontWeight:500,
            }}
              onMouseEnter={e=>e.currentTarget.style.background=C.ivoryDark}
              onMouseLeave={e=>e.currentTarget.style.background=C.ivory}
            >Bugün</button>

            {}
            <div style={{
              display:"flex", alignItems:"center", gap:0,
              border:`1px solid ${C.border}`, borderRadius:7, overflow:"hidden",
              flex: isMobile ? 1 : "none", minWidth:0,
            }}>
              <button onClick={goBack} style={{
                padding: isMobile ? "9px 10px" : "7px 11px", border:"none", background:C.white,
                cursor:"pointer", color:C.textMid, flexShrink:0,
                borderRight:`1px solid ${C.border}`,
                transition:"background .1s",
              }}
                onMouseEnter={e=>e.currentTarget.style.background=C.ivory}
                onMouseLeave={e=>e.currentTarget.style.background=C.white}
              >
                <CIc d="M15 18l-6-6 6-6" size={15} sw={2}/>
              </button>
              <div style={{
                padding: isMobile ? "7px 6px" : "7px 16px", fontFamily:"'DM Sans',sans-serif",
                fontSize: isMobile ? 12 : 13, fontWeight:500, color:C.text,
                flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                textAlign:"center", background:C.white,
              }}>{navLabel()}</div>
              <button onClick={goForward} style={{
                padding: isMobile ? "9px 10px" : "7px 11px", border:"none", background:C.white,
                cursor:"pointer", color:C.textMid, flexShrink:0,
                borderLeft:`1px solid ${C.border}`,
                transition:"background .1s",
              }}
                onMouseEnter={e=>e.currentTarget.style.background=C.ivory}
                onMouseLeave={e=>e.currentTarget.style.background=C.white}
              >
                <CIc d="M9 18l6-6-6-6" size={15} sw={2}/>
              </button>
            </div>
          </div>

          {}
          <div style={{
            display:"flex", background:C.ivory, width: isMobile ? "100%" : "auto",
            border:`1px solid ${C.border}`, borderRadius:8, padding:2,
          }}>
            {(isMobile ? mobileViewTabs : desktopViewTabs).map(({k,l})=>(
              <button key={k} onClick={()=>setView(k)} style={{
                padding: isMobile ? "8px 13px" : "5px 13px", borderRadius:6, cursor:"pointer",
                border:"none", flex: isMobile ? 1 : "none",
                background: view===k ? C.navy : "transparent",
                color: view===k ? C.white : C.textMuted,
                fontFamily:"'DM Sans',sans-serif", fontSize:12.5,
                fontWeight: view===k ? 500 : 400,
                transition:"all .12s",
              }}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {}
      <div className="rsp-split" style={{ display:"grid", gridTemplateColumns:"minmax(0, 1fr) 280px", gap:20, alignItems:"start" }}>

        {}
        <div>
          {isMobile ? (
            effectiveView === "monthly" ? (
              <MonthlyView monthStart={monthStart} events={visibleEvents} onSelectDay={selectDayFromMonth} isMobile/>
            ) : (
              <MobileAgendaView date={currentDay} events={visibleEvents}/>
            )
          ) : visibleEvents.length === 0 && view !== "monthly" && view !== "weekly" ? (
            <div style={{
              background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
              padding:"80px 40px", textAlign:"center",
            }}>
              <div style={{ fontSize:40, marginBottom:16, opacity:.25 }}>🗓</div>
              <div style={{ fontSize:16, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6 }}>
                Bu tarih aralığında planlanmış tur bulunmuyor.
              </div>
              <div style={{ fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>
                Başka bir tarih seçin veya yeni rezervasyon ekleyin.
              </div>
            </div>
          ) : view === "weekly" ? (
            <WeeklyView weekStart={weekStart} events={visibleEvents}/>
          ) : view === "daily" ? (
            <DailyView date={currentDay} events={visibleEvents}/>
          ) : (
            <MonthlyView monthStart={monthStart} events={visibleEvents} onSelectDay={selectDayFromMonth}/>
          )}
        </div>

        {}
        <CalSidebar todayEvents={todayEvents} weekEvents={visibleEvents}/>
      </div>
    </div>
  );
}

const TASK_PRIORITY = {
  "Acil":   { color:"#C0392B", bg:"#FDECEC", dot:"#C0392B", order:0 },
  "Yüksek": { color:"#B45309", bg:"#FEF3E2", dot:"#B45309", order:1 },
  "Orta":   { color:"#1A6FAE", bg:"#E8F2FB", dot:"#1A6FAE", order:2 },
  "Düşük":  { color:"#6B7280", bg:"#F3F4F6", dot:"#9CA3AF", order:3 },
};

const TASK_STATUS = {
  "Açık":         { color:"#1A6FAE", bg:"#E8F2FB" },
  "Devam Ediyor": { color:"#B45309", bg:"#FEF3E2" },
  "Tamamlandı":   { color:"#2E7D52", bg:"#EBF5EF" },
  "İptal":        { color:"#9CA3AF", bg:"#F3F4F6" },
};

const TASK_CATEGORY = {
  "Teklif":        { color:"#6B3FA0", bg:"#F3EEF9" },
  "Ödeme":         { color:"#C05621", bg:"#FEF0E8" },
  "Rezervasyon":   { color:"#1A6FAE", bg:"#E8F2FB" },
  "Operasyon":     { color:"#2E7D52", bg:"#EBF5EF" },
  "Rehber":        { color:"#B8973A", bg:"#F5EDD4" },
  "Pickup":        { color:"#0E7490", bg:"#ECFEFF" },
  "Müşteri Takibi":{ color:"#6B7280", bg:"#F3F4F6" },
};

const TODAY_STR = "03 Haz 2026";
const TOMORROW_STR = "04 Haz 2026";

const MOCK_TASKS = DB.tasks; // → centralized DB

function TIc({ d, size=15, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function TPill({ label, map, small }) {
  const m = map[label] || { color:"#6B7280", bg:"#F3F4F6" };
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:4,
      padding: small ? "2px 7px" : "3px 9px",
      borderRadius:99, fontSize: small ? 10.5 : 11.5,
      fontWeight:500, color:m.color, background:m.bg,
      fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap",
    }}>
      {m.dot && <span style={{width:5, height:5, borderRadius:"50%", background:m.dot, flexShrink:0}}/>}
      {label}
    </span>
  );
}

function TCatPill({ label }) {
  const m = TASK_CATEGORY[label] || { color:"#6B7280", bg:"#F3F4F6" };
  return (
    <span style={{
      display:"inline-block", padding:"2px 8px", borderRadius:5,
      fontSize:11, fontWeight:500, color:m.color, background:m.bg,
      fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap",
    }}>{label}</span>
  );
}

function TAssignee({ name, initials }) {
  if (!initials) return (
    <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontStyle:"italic"}}>
      Atanmadı
    </span>
  );
  return (
    <div style={{display:"flex", alignItems:"center", gap:7}}>
      <div style={{
        width:26, height:26, borderRadius:"50%", flexShrink:0,
        background:"rgba(27,45,79,0.09)", border:"1.5px solid rgba(27,45,79,0.14)",
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>
        <span style={{fontSize:9.5, fontWeight:700, color:C.navy}}>{initials}</span>
      </div>
      <span style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}>{name}</span>
    </div>
  );
}

function TDueDate({ task }) {
  const overdue  = task.dueDateRaw < 0 && task.status !== "Tamamlandı";
  const isToday  = task.dueDateRaw === 0;
  const isTomorrow = task.dueDateRaw === 1;
  const done     = task.status === "Tamamlandı";
  const color    = done ? C.textFaint : overdue ? C.red : isToday ? C.amber : C.textMid;
  const label    = done ? task.dueDate : overdue ? `${Math.abs(task.dueDateRaw)} gün gecikti`
    : isToday ? "Bugün" : isTomorrow ? "Yarın" : task.dueDate;

  return (
    <div style={{display:"flex", alignItems:"center", gap:5}}>
      {overdue && !done && (
        <span style={{width:6, height:6, borderRadius:"50%", background:C.red, flexShrink:0}}/>
      )}
      <span style={{
        fontSize:12.5, color,
        fontFamily:"'DM Sans',sans-serif",
        fontWeight: (overdue || isToday) && !done ? 600 : 400,
      }}>{label}</span>
    </div>
  );
}

function TaskRow({ task, isLast, onToggle }) {
  const done = task.status === "Tamamlandı";
  const pMeta = TASK_PRIORITY[task.priority] || {};

  return (
    <tr
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        background:C.white,
        transition:"background .1s",
        opacity: task.status === "İptal" ? 0.5 : 1,
      }}
    >
      {}
      <td style={{
        padding:"13px 8px 13px 20px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle", width:40,
      }}>
        <div
          onClick={()=>onToggle(task.id)}
          style={{
            width:18, height:18, borderRadius:5, cursor:"pointer",
            border: done ? "none" : `1.5px solid ${C.border}`,
            background: done ? C.green : C.white,
            display:"flex", alignItems:"center", justifyContent:"center",
            transition:"all .15s", flexShrink:0,
          }}
        >
          {done && <TIc d="M20 6L9 17l-5-5" size={11} sw={2.5} color="#fff"/>}
        </div>
      </td>

      {}
      <td style={{
        padding:"13px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <div style={{display:"flex", alignItems:"flex-start", gap:10}}>
          {}
          <div style={{
            width:3, height:36, borderRadius:99, flexShrink:0, marginTop:2,
            background: done ? C.border : pMeta.dot || C.border,
          }}/>
          <div style={{minWidth:0}}>
            <div style={{
              fontSize:13.5, fontWeight:500,
              color: done ? C.textFaint : C.text,
              fontFamily:"'DM Sans',sans-serif",
              textDecoration: done ? "line-through" : "none",
              lineHeight:1.4,
            }}>{task.title}</div>
            <div style={{
              fontSize:11.5, color:C.textFaint,
              fontFamily:"'DM Sans',sans-serif", marginTop:3,
              display:"flex", alignItems:"center", gap:6,
            }}>
              <span>{task.guestFlag} {task.guest}</span>
              <span style={{color:C.borderLight}}>·</span>
              <span style={{
                fontSize:11, color:C.textFaint,
                fontFamily:"'DM Mono',monospace",
              }}>{task.relatedType}: {task.relatedId}</span>
            </div>
          </div>
        </div>
      </td>

      {}
      <td style={{
        padding:"13px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <TCatPill label={task.category}/>
      </td>

      {}
      <td style={{
        padding:"13px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <TPill label={task.priority} map={TASK_PRIORITY} small/>
      </td>

      {}
      <td style={{
        padding:"13px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <TDueDate task={task}/>
      </td>

      {}
      <td style={{
        padding:"13px 12px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <TAssignee name={task.assignee} initials={task.assigneeInitials}/>
      </td>

      {}
      <td style={{
        padding:"13px 16px 13px 8px",
        borderBottom: isLast ? "none" : `1px solid ${C.borderLight}`,
        verticalAlign:"middle",
      }}>
        <TPill label={task.status} map={TASK_STATUS} small/>
      </td>
    </tr>
  );
}

function TaskSidebar({ tasks }) {
  const urgent = tasks
    .filter(t => t.status !== "Tamamlandı" && t.status !== "İptal")
    .sort((a,b) => {
      const pOrder = (TASK_PRIORITY[a.priority]?.order||9) - (TASK_PRIORITY[b.priority]?.order||9);
      if (pOrder !== 0) return pOrder;
      return a.dueDateRaw - b.dueDateRaw;
    })
    .slice(0, 6);

  return (
    <div style={{
      background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
      overflow:"hidden",
    }}>
      {}
      <div style={{
        background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
        padding:"16px 18px",
      }}>
        <div style={{fontSize:14, fontWeight:600, color:C.ivory, fontFamily:"'Playfair Display',serif", marginBottom:2}}>
          Öncelikli İşler
        </div>
        <div style={{fontSize:11.5, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Sans',sans-serif"}}>
          Acil ve yaklaşan görevler
        </div>
      </div>

      {}
      <div style={{padding:"8px 0"}}>
        {urgent.length === 0 ? (
          <div style={{
            padding:"32px 20px", textAlign:"center",
            color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontSize:13,
          }}>
            Tüm öncelikli görevler tamamlandı ✓
          </div>
        ) : urgent.map((task, i) => {
          const pMeta = TASK_PRIORITY[task.priority] || {};
          const overdue = task.dueDateRaw < 0;
          const isToday = task.dueDateRaw === 0;
          return (
            <div key={task.id} style={{
              padding:"11px 16px",
              borderBottom: i < urgent.length-1 ? `1px solid ${C.borderLight}` : "none",
              display:"flex", gap:11, alignItems:"flex-start",
              cursor:"pointer",
            }}
              onMouseEnter={e=>e.currentTarget.style.background=C.ivory}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}
            >
              {}
              <div style={{
                width:8, height:8, borderRadius:"50%", flexShrink:0,
                background:pMeta.dot, marginTop:6,
                boxShadow:`0 0 0 3px ${pMeta.dot}22`,
              }}/>
              <div style={{flex:1, minWidth:0}}>
                <div style={{
                  fontSize:13, fontWeight:500, color:C.text,
                  fontFamily:"'DM Sans',sans-serif", lineHeight:1.35,
                  marginBottom:4,
                  overflow:"hidden", textOverflow:"ellipsis",
                  display:"-webkit-box", WebkitLineClamp:2,
                  WebkitBoxOrient:"vertical",
                }}>{task.title}</div>
                <div style={{display:"flex", alignItems:"center", gap:6, flexWrap:"wrap"}}>
                  <TCatPill label={task.category}/>
                  <span style={{
                    fontSize:11, fontWeight:600,
                    color: overdue ? C.red : isToday ? C.amber : C.textFaint,
                    fontFamily:"'DM Sans',sans-serif",
                  }}>
                    {overdue ? `${Math.abs(task.dueDateRaw)} gün gecikti`
                     : isToday ? "Bugün"
                     : task.dueDate}
                  </span>
                </div>
              </div>
              <TIc d="M9 18l6-6-6-6" size={13} sw={1.8} color={C.textFaint}/>
            </div>
          );
        })}
      </div>

      {}
      <div style={{
        padding:"10px 16px",
        borderTop:`1px solid ${C.borderLight}`,
        background:C.ivory,
      }}>
        <button style={{
          width:"100%", background:"none", border:"none", cursor:"pointer",
          fontSize:12.5, color:C.goldLight, fontWeight:500,
          fontFamily:"'DM Sans',sans-serif",
          display:"flex", alignItems:"center", justifyContent:"center", gap:5,
        }}>
          Tüm Görevleri Gör
          <TIc d="M9 18l6-6-6-6" size={13} sw={2} color={C.goldLight}/>
        </button>
      </div>
    </div>
  );
}

function TasksPage() {
  const [showNewTask, setShowNewTask] = useState(false);
  const [_taskTick, setTaskTick] = useState(0);
  const [activeTab, setActiveTab]   = useState("Tümü");
  const [activeFilter, setActiveFilter] = useState("Tümü");
  const [search, setSearch]         = useState("");
  const { data:repoTasks, loading:tasksLoading, error:tasksError, reload:reloadTasks }
    = useRepo("task", "getAll");

  const TABS = ["Tümü", "Bugün", "Geciken", "Bu Hafta", "Tamamlananlar"];

  async function toggleTask(id) {
    const repo = getActiveRepo("task");
    await Promise.resolve(repo.toggle(id));
    setTaskTick(n=>n+1);
    reloadTasks && reloadTasks();
  }

  const tasks = repoTasks ?? [];
  const filtered = tasks.filter(t => {
    if (search && !t.title.toLowerCase().includes(search.toLowerCase()) &&
        !t.guest.toLowerCase().includes(search.toLowerCase())) return false;
    if (activeTab === "Bugün")         return t.dueDateRaw === 0 && t.status !== "Tamamlandı";
    if (activeTab === "Geciken")       return t.dueDateRaw < 0 && t.status !== "Tamamlandı";
    if (activeTab === "Bu Hafta")      return t.dueDateRaw >= 0 && t.dueDateRaw <= 7 && t.status !== "Tamamlandı";
    if (activeTab === "Tamamlananlar") return t.status === "Tamamlandı";
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (a.status === "Tamamlandı" && b.status !== "Tamamlandı") return 1;
    if (b.status === "Tamamlandı" && a.status !== "Tamamlandı") return -1;
    const pOrder = (TASK_PRIORITY[a.priority]?.order||9) - (TASK_PRIORITY[b.priority]?.order||9);
    if (pOrder !== 0) return pOrder;
    return a.dueDateRaw - b.dueDateRaw;
  });

  const todayCount    = tasks.filter(t => t.dueDateRaw === 0 && t.status !== "Tamamlandı").length;
  const overdueCount  = tasks.filter(t => t.dueDateRaw < 0  && t.status !== "Tamamlandı").length;
  const urgentCount   = tasks.filter(t => t.priority === "Acil" && t.status !== "Tamamlandı").length;
  const doneCount     = tasks.filter(t => t.status === "Tamamlandı").length;

  const tabCounts = {
    "Tümü":          tasks.filter(t=>t.status!=="Tamamlandı").length,
    "Bugün":         todayCount,
    "Geciken":       overdueCount,
    "Bu Hafta":      tasks.filter(t=>t.dueDateRaw>=0&&t.dueDateRaw<=7&&t.status!=="Tamamlandı").length,
    "Tamamlananlar": doneCount,
  };

  return (
    <>
    {showNewTask ? (<NewTaskModal onClose={()=>{ setShowNewTask(false); reloadTasks && reloadTasks(); }}/>) : null}
    <div style={{display:"flex", flexDirection:"column", gap:20}}>

      {}
      <div className="page-header" style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"20px 24px",
        display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:20,
      }}>
        <div>
          <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:5}}>Görevler</h1>
          <p style={{margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
            Satış ve operasyon ekibinin yapması gereken işleri takip edin.
          </p>
        </div>
        <div className="page-header-actions" style={{display:"flex", alignItems:"center", gap:10, flexShrink:0}}>
          {}
          <div style={{position:"relative"}}>
            <span style={{position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.textFaint, pointerEvents:"none"}}>
              <TIc d="M21 21l-4.35-4.35 M17 11A6 6 0 105 11a6 6 0 0012 0z" size={14} sw={1.8}/>
            </span>
            <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Görev veya misafir ara…"
              style={{
                paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
                border:`1px solid ${C.border}`, borderRadius:8,
                background:C.ivory, fontSize:13, color:C.text,
                fontFamily:"'DM Sans',sans-serif", outline:"none", width:"min(220px,45vw)",
                transition:"border-color .15s, box-shadow .15s",
              }}
              onFocus={e=>{ e.target.style.borderColor=C.gold; e.target.style.boxShadow=`0 0 0 3px ${C.gold}20`; }}
              onBlur={e=>{ e.target.style.borderColor=C.border; e.target.style.boxShadow="none"; }}
            />
          </div>
          <button style={{
            display:"flex", alignItems:"center", gap:7,
            padding:"9px 16px", borderRadius:8,
            border:"none", background:C.navy, cursor:"pointer", color:C.white,
            fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.navyHover}
            onMouseLeave={e=>e.currentTarget.style.background=C.navy}
          onClick={()=>setShowNewTask(true)}
          >
            <TIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
            Yeni Görev Ekle
          </button>
        </div>
      </div>

      {}
      <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14}}>
        {[
          {
            label:"Bugünkü Görevler", val:todayCount,
            icon:"M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z",
            color:C.blue, bg:C.blueBg,
            sub: todayCount > 0 ? "Bugün tamamlanmalı" : "Bugün görev yok",
          },
          {
            label:"Geciken Görevler", val:overdueCount,
            icon:"M12 8v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z",
            color:C.red, bg:C.redBg,
            sub: overdueCount > 0 ? "Hemen ilgilenilmeli" : "Geciken görev yok ✓",
          },
          {
            label:"Acil Görevler", val:urgentCount,
            icon:"M13 10V3L4 14h7v7l9-11h-7z",
            color:C.amber, bg:C.amberBg,
            sub: urgentCount > 0 ? "Acil öncelikli" : "Acil görev yok ✓",
          },
          {
            label:"Tamamlananlar", val:doneCount,
            icon:"M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3",
            color:C.green, bg:C.greenBg,
            sub:`${tasks.length} görevden ${doneCount} tamamlandı`,
          },
        ].map((k,i)=>(
          <div key={i} style={{
            background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
            padding:"18px 20px", display:"flex", alignItems:"flex-start", gap:14,
          }}>
            <div style={{
              width:42, height:42, borderRadius:10, flexShrink:0,
              background:k.bg, display:"flex", alignItems:"center", justifyContent:"center",
              color:k.color,
            }}>
              <TIc d={k.icon} size={18} sw={1.6} color={k.color}/>
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:26, fontWeight:700, color:k.color, fontFamily:"'Playfair Display',serif", lineHeight:1, marginBottom:4}}>
                {k.val}
              </div>
              <div style={{fontSize:12, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginBottom:3}}>{k.label}</div>
              <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{k.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {}
      <div className="rsp-split" style={{display:"grid", gridTemplateColumns:"1fr 280px", gap:20, alignItems:"start"}}>

        {}
        <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>

          {}
          <div style={{
            display:"flex", alignItems:"center",
            borderBottom:`1px solid ${C.borderLight}`,
            padding:"0 20px", overflowX:"auto",
          }}>
            {TABS.map(tab => {
              const on = activeTab === tab;
              const cnt = tabCounts[tab];
              return (
                <button key={tab} onClick={()=>setActiveTab(tab)} style={{
                  padding:"13px 14px",
                  border:"none", borderBottom: on ? `2px solid ${C.gold}` : "2px solid transparent",
                  background:"transparent",
                  color: on ? C.gold : C.textMuted,
                  fontFamily:"'DM Sans',sans-serif", fontSize:13,
                  fontWeight: on ? 600 : 400, cursor:"pointer",
                  whiteSpace:"nowrap", marginBottom:-1,
                  display:"flex", alignItems:"center", gap:6,
                  transition:"color .12s",
                }}>
                  {tab}
                  {cnt > 0 && (
                    <span style={{
                      minWidth:18, height:18, borderRadius:99, padding:"0 5px",
                      display:"inline-flex", alignItems:"center", justifyContent:"center",
                      fontSize:10.5, fontWeight:600,
                      background: on ? `${C.gold}22` : C.ivoryDark,
                      color: on ? C.gold : C.textFaint,
                    }}>{cnt}</span>
                  )}
                </button>
              );
            })}
            <div style={{marginLeft:"auto", padding:"0 4px", flexShrink:0}}>
              <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
                {sorted.length} görev
              </span>
            </div>
          </div>

          {}
          {tasksLoading ? <LoadingState label="Görevler yükleniyor…"/> :
           tasksError   ? <ErrorState message={tasksError} onRetry={reloadTasks}/> :
           sorted.length === 0 ? (
            <div style={{padding:"64px 40px", textAlign:"center"}}>
              <div style={{fontSize:36, opacity:.2, marginBottom:14}}>✓</div>
              <div style={{fontSize:16, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6}}>
                Henüz görev bulunmuyor.
              </div>
              <div style={{fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
                Bu filtre için tamamlanmış veya kayıt yok.
              </div>
              <button style={{
                marginTop:20, display:"inline-flex", alignItems:"center", gap:7,
                padding:"9px 18px", borderRadius:8,
                border:`1.5px solid ${C.gold}`, background:C.goldPale,
                cursor:"pointer", color:C.gold,
                fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
              }}>
                <TIc d="M12 5v14M5 12h14" size={14} sw={2.5} color={C.gold}/>
                Yeni Görev Ekle
              </button>
            </div>
          ) : (
            <>
              <table style={{width:"100%", borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{borderBottom:`1px solid ${C.border}`, background:C.ivory}}>
                    <th style={{padding:"10px 8px 10px 20px", width:40}}/>
                    {["Görev","Kategori","Öncelik","Son Tarih","Sorumlu","Durum"].map((h,i)=>(
                      <th key={h} style={{
                        padding:"10px 12px",
                        textAlign:"left", fontSize:10.5, fontWeight:600,
                        color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
                        textTransform:"uppercase", letterSpacing:"0.07em",
                        whiteSpace:"nowrap",
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((task, i) => (
                    <TaskRow
                      key={task.id} task={task}
                      isLast={i===sorted.length-1}
                      onToggle={toggleTask}
                    />
                  ))}
                </tbody>
              </table>
            <div className="rsp-cards"><MobileCardList items={filtered} renderCard={(item,i)=>(
                <MobileCard key={item.id}>
                  <div>
                    <div style={{fontWeight:600,fontSize:14,color:C.text}}>{item.title}</div>
                    <div style={{fontSize:12,color:C.textMuted,marginTop:2}}>{item.dueDate||"—"} · {item.assignee||"—"}</div>
                  </div>
                </MobileCard>
              )}/></div>

              {}
              <div style={{
                padding:"10px 20px", background:C.ivory,
                borderTop:`1px solid ${C.borderLight}`,
                display:"flex", alignItems:"center", justifyContent:"space-between",
              }}>
                <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
                  {sorted.length} / {tasks.length} görev gösteriliyor
                </span>
                <div style={{display:"flex", alignItems:"center", gap:6}}>
                  <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
                    {doneCount} tamamlandı · {overdueCount > 0 ? `${overdueCount} gecikiyor` : "geciken yok"}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        {}
        <TaskSidebar tasks={tasks}/>
      </div>
    </div>
    </>
  );
}

const PAY_STATUS_MAP = {
  "Bekliyor":      { color:"#C05621", bg:"#FEF0E8", dot:"#C05621" },
  "Kısmi Ödendi":  { color:"#B8973A", bg:"#F5EDD4", dot:"#B8973A" },
  "Tamamlandı":    { color:"#2E7D52", bg:"#EBF5EF", dot:"#2E7D52" },
  "İade Edildi":   { color:"#6B3FA0", bg:"#F3EEF9", dot:"#6B3FA0" },
};

const PAY_METHOD_MAP = {
  "Banka Transferi": "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z",
  "Kredi Kartı":     "M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20",
  "Nakit":           "M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
  "Wise":            "M12 2a10 10 0 100 20A10 10 0 0012 2z",
  "PayPal":          "M7 11.5h2m0 0c0-2.5 2-4 4-4s4 1.5 4 4-2 4-4 4H9l-2 4",
  "Diğer":           "M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
};

const MOCK_PAYMENTS = DB.payments; // → centralized DB

function PIc({ d, size=15, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function PBadge({ label, small }) {
  const m = PAY_STATUS_MAP[label] || { color:"#6B7280", bg:"#F3F4F6", dot:"#9CA3AF" };
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding: small ? "3px 8px" : "4px 11px",
      borderRadius:99, fontSize: small ? 11 : 12, fontWeight:500,
      color:m.color, background:m.bg, whiteSpace:"nowrap",
      fontFamily:"'DM Sans',sans-serif",
    }}>
      <span style={{width:6, height:6, borderRadius:"50%", background:m.dot, flexShrink:0}}/>
      {label}
    </span>
  );
}

function fmtMoney(amount, currency) {
  const sym = currency === "TRY" ? "₺" : currency === "USD" ? "$" : currency === "GBP" ? "£" : "€";
  return `${sym}${amount.toLocaleString("tr-TR")}`;
}

function PctBar({ pct, color }) {
  return (
    <div style={{width:"100%", height:4, background:"#F0EBE1", borderRadius:99, overflow:"hidden", marginTop:4}}>
      <div style={{width:`${Math.min(pct,100)}%`, height:"100%", background:color||C.gold, borderRadius:99, transition:"width .3s"}}/>
    </div>
  );
}

function PaymentDrawer({ payment, onClose }) {
  if (!payment) return null;
  const pct = payment.total > 0 ? Math.round(payment.paid / payment.total * 100) : 0;
  const overdue = payment.dueDateRaw < 0 && payment.status !== "Tamamlandı" && payment.status !== "İade Edildi";

  const ACTIONS = [
    { label:"Ödeme Kaydı Ekle",            icon:"M12 5v14M5 12h14", primary:true },
    { label:"Kapora Ekle",                  icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20" },
    { label:"Tamamlandı Olarak İşaretle",   icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", green:true },
    { label:"Hatırlatma Oluştur",           icon:"M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" },
  ];

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:200,
      display:"flex", justifyContent:"flex-end",
    }}>
      {}
      <div onClick={onClose} style={{
        position:"absolute", inset:0,
        background:"rgba(13,27,62,0.35)",
        backdropFilter:"blur(2px)",
      }}/>

      {}
      <div style={{
        position:"relative", zIndex:1,
        width:400, height:"100%",
        background:C.white,
        boxShadow:"-8px 0 40px rgba(13,27,62,0.18)",
        display:"flex", flexDirection:"column",
        overflowY:"auto",
      }}>
        {}
        <div style={{
          background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
          padding:"20px 22px",
          display:"flex", alignItems:"flex-start", justifyContent:"space-between",
          flexShrink:0,
        }}>
          <div>
            <div style={{fontSize:11, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Mono',monospace", marginBottom:6}}>
              {payment.id} · {payment.resId}
            </div>
            <div style={{fontSize:17, fontWeight:700, color:C.ivory, fontFamily:"'Playfair Display',serif", lineHeight:1.2}}>
              {payment.flag} {payment.guest}
            </div>
            <div style={{fontSize:12.5, color:"rgba(248,245,238,0.55)", fontFamily:"'DM Sans',sans-serif", marginTop:4}}>
              {payment.tour}
            </div>
          </div>
          <button onClick={onClose} style={{
            background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.15)",
            borderRadius:8, padding:6, cursor:"pointer", color:C.ivory,
            display:"flex", alignItems:"center", justifyContent:"center",
            flexShrink:0, marginTop:2,
          }}>
            <PIc d="M18 6L6 18M6 6l12 12" size={14} sw={2}/>
          </button>
        </div>

        {}
        <div style={{
          background:C.ivory, borderBottom:`1px solid ${C.border}`,
          padding:"18px 22px",
          display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12,
        }}>
          {[
            { label:"Toplam Tutar", val:fmtMoney(payment.total, payment.currency), big:true, color:C.text },
            { label:"Kapora",       val:fmtMoney(payment.deposit, payment.currency), color:C.amber },
            { label:"Kalan",        val:fmtMoney(payment.remaining, payment.currency), color: payment.remaining > 0 ? C.red : C.green },
          ].map((r,i)=>(
            <div key={i} style={{
              background:C.white, borderRadius:8, padding:"10px 12px",
              border:`1px solid ${C.borderLight}`, textAlign:"center",
            }}>
              <div style={{fontSize:10.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginBottom:5}}>{r.label}</div>
              <div style={{fontSize: r.big ? 17 : 15, fontWeight:700, color:r.color, fontFamily:"'Playfair Display',serif", lineHeight:1}}>{r.val}</div>
            </div>
          ))}
          {}
          <div style={{gridColumn:"1/-1"}}>
            <div style={{display:"flex", justifyContent:"space-between", marginBottom:5}}>
              <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>Ödeme İlerlemesi</span>
              <span style={{fontSize:12, fontWeight:600, color:C.gold, fontFamily:"'DM Sans',sans-serif"}}>%{pct}</span>
            </div>
            <div style={{height:6, background:C.ivoryDark, borderRadius:99, overflow:"hidden"}}>
              <div style={{width:`${pct}%`, height:"100%", background:C.gold, borderRadius:99}}/>
            </div>
          </div>
        </div>

        {}
        <div style={{flex:1, padding:"4px 0"}}>
          {[
            { label:"Durum",         val:null,                     badge:payment.status },
            { label:"Para Birimi",   val:payment.currency },
            { label:"Ödeme Yöntemi", val:payment.method === "—" ? "Henüz belirlenmedi" : payment.method },
            { label:"Kapora Tarihi", val:payment.depositDate },
            { label:"Son Ödeme Tarihi", val:payment.dueDate, alert:overdue },
            { label:"Rezervasyon",   val:payment.resId },
            { label:"Oluşturulma",   val:payment.createdAt },
          ].map((r,i,arr)=>(
            <div key={i} style={{
              display:"flex", justifyContent:"space-between", alignItems:"center",
              padding:"11px 22px",
              borderBottom: i<arr.length-1 ? `1px solid ${C.borderLight}` : "none",
            }}>
              <span style={{fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{r.label}</span>
              {r.badge
                ? <PBadge label={r.badge} small/>
                : <span style={{
                    fontSize:13, color: r.alert ? C.red : C.text,
                    fontFamily:"'DM Sans',sans-serif", fontWeight: r.alert ? 600 : 400,
                  }}>{r.val}</span>
              }
            </div>
          ))}

          {}
          {payment.notes && (
            <div style={{padding:"14px 22px"}}>
              <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:8}}>Not</div>
              <div style={{
                fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif",
                background:C.ivory, borderRadius:8, padding:"10px 12px",
                border:`1px solid ${C.borderLight}`, lineHeight:1.6,
              }}>{payment.notes}</div>
            </div>
          )}
        </div>

        {}
        <div style={{
          borderTop:`1px solid ${C.border}`, padding:"14px 16px",
          background:C.ivory, flexShrink:0,
        }}>
          <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:10}}>Hızlı İşlemler</div>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:7}}>
            {ACTIONS.map((a,i)=>{
              return (
                <button key={i}
                  onMouseEnter={e=>e.currentTarget.style.opacity="0.8"}
                  onMouseLeave={e=>e.currentTarget.style.opacity="1"}
                  style={{
                    display:"flex", alignItems:"center", gap:7,
                    padding:"9px 12px", borderRadius:7, cursor:"pointer",
                    border: a.primary ? "none" : a.green ? `1px solid ${C.green}44` : `1px solid ${C.border}`,
                    background: a.primary ? C.navy : a.green ? C.greenBg : C.white,
                    color: a.primary ? C.white : a.green ? C.green : C.text,
                    fontFamily:"'DM Sans',sans-serif", fontSize:12, fontWeight: a.primary?600:400,
                    textAlign:"left", transition:"background .12s",
                  }}>
                  <PIc d={a.icon} size={13} sw={a.primary?2.5:1.6}/>
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function PaymentRow({ p, isLast, onOpen }) {
  const overdue = p.dueDateRaw < 0 && p.status !== "Tamamlandı" && p.status !== "İade Edildi";
  const pct = p.total > 0 ? Math.round(p.paid / p.total * 100) : 0;

  return (
    <tr
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      onClick={()=>onOpen(p)}
      style={{
        background:C.white,
        cursor:"pointer", transition:"background .1s",
        opacity: p.status === "İade Edildi" ? 0.65 : 1,
      }}
    >
      {}
      <td style={{padding:"14px 16px 14px 22px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <div style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{p.flag} {p.guest}</div>
        <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2}}>{p.country}</div>
      </td>
      {}
      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <span style={{
          fontSize:11.5, fontWeight:600, color:C.navy,
          fontFamily:"'DM Mono',monospace",
          background:C.ivory, border:`1px solid ${C.borderLight}`,
          padding:"2px 7px", borderRadius:5,
        }}>{p.resId}</span>
      </td>
      {}
      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle", maxWidth:170}}>
        <div style={{fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif", fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{p.tour}</div>
      </td>
      {}
      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <div style={{fontSize:15, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif"}}>{fmtMoney(p.total, p.currency)}</div>
        <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:1}}>{p.currency}</div>
      </td>
      {}
      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <div style={{fontSize:13.5, fontWeight:500, color:C.amber, fontFamily:"'Playfair Display',serif"}}>{fmtMoney(p.deposit, p.currency)}</div>
      </td>
      {}
      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <div style={{fontSize:13.5, fontWeight:600, color: p.remaining > 0 ? C.red : C.green, fontFamily:"'Playfair Display',serif"}}>
          {fmtMoney(p.remaining, p.currency)}
        </div>
        {}
        <PctBar pct={pct} color={p.remaining===0 ? C.green : C.gold}/>
      </td>
      {}
      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <div style={{
          fontSize:12.5, fontWeight: overdue ? 600 : 400,
          color: overdue ? C.red : p.status==="Tamamlandı"||p.status==="İade Edildi" ? C.textFaint : C.textMid,
          fontFamily:"'DM Sans',sans-serif",
          display:"flex", alignItems:"center", gap:5,
        }}>
          {overdue && <span style={{width:6, height:6, borderRadius:"50%", background:C.red, flexShrink:0}}/>}
          {overdue ? `${Math.abs(p.dueDateRaw)} gün gecikti` : p.dueDate}
        </div>
      </td>
      {}
      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <PBadge label={p.status} small/>
      </td>
      {}
      <td style={{padding:"14px 16px 14px 8px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <PIc d="M9 18l6-6-6-6" size={14} sw={1.8} color={C.textFaint}/>
      </td>
    </tr>
  );
}

function PaySidebar({ payments }) {
  const overdue   = payments.filter(p => p.dueDateRaw < 0 && !["Tamamlandı","İade Edildi"].includes(p.status));
  const upcoming  = payments.filter(p => p.dueDateRaw >= 0 && p.dueDateRaw <= 14 && !["Tamamlandı","İade Edildi"].includes(p.status));
  const highValue = payments
    .filter(p => p.remaining > 1000 && !["Tamamlandı","İade Edildi"].includes(p.status))
    .sort((a,b) => b.remaining - a.remaining)
    .slice(0, 3);

  function SideGroup({ title, items, emptyMsg, icon, iconColor }) {
    return (
      <div style={{marginBottom:20}}>
        <div style={{
          display:"flex", alignItems:"center", gap:7, marginBottom:10,
          fontSize:10.5, fontWeight:600, color:C.textFaint,
          textTransform:"uppercase", letterSpacing:"0.09em",
          fontFamily:"'DM Sans',sans-serif",
        }}>
          <PIc d={icon} size={13} sw={1.6} color={iconColor}/>
          {title}
          {items.length > 0 && (
            <span style={{
              marginLeft:"auto", fontSize:11, fontWeight:700, color:"#fff",
              background:iconColor, borderRadius:"50%",
              width:18, height:18, display:"inline-flex", alignItems:"center", justifyContent:"center",
            }}>{items.length}</span>
          )}
        </div>
        {items.length === 0 ? (
          <div style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontStyle:"italic", paddingLeft:4}}>{emptyMsg}</div>
        ) : items.map((p,i) => (
          <div key={i} style={{
            padding:"10px 12px", borderRadius:8,
            background:C.ivory, border:`1px solid ${C.borderLight}`,
            marginBottom:6, cursor:"pointer",
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.ivoryDark}
            onMouseLeave={e=>e.currentTarget.style.background=C.ivory}
          >
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:3}}>
              <div style={{fontSize:12.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{p.flag} {p.guest}</div>
              <div style={{fontSize:13, fontWeight:700, color:iconColor, fontFamily:"'Playfair Display',serif", flexShrink:0}}>
                {fmtMoney(p.remaining, p.currency)}
              </div>
            </div>
            <div style={{fontSize:11.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>{p.resId} · {p.dueDate}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
      {}
      <div style={{
        background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
        padding:"16px 18px",
      }}>
        <div style={{fontSize:14, fontWeight:600, color:C.ivory, fontFamily:"'Playfair Display',serif", marginBottom:2}}>Tahsilat Takibi</div>
        <div style={{fontSize:11.5, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Sans',sans-serif"}}>Acil ve yaklaşan ödemeler</div>
      </div>
      <div style={{padding:"16px 16px 8px"}}>
        <SideGroup
          title="Geciken Ödemeler" items={overdue} emptyMsg="Geciken ödeme yok ✓"
          icon="M12 8v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          iconColor={C.red}
        />
        <SideGroup
          title="Yaklaşan Son Tarihler (14 gün)" items={upcoming} emptyMsg="Yaklaşan son tarih yok"
          icon="M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z"
          iconColor={C.amber}
        />
        <SideGroup
          title="Yüksek Tutarlı Bekleyenler" items={highValue} emptyMsg="Yüksek tutarlı bekleme yok"
          icon="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
          iconColor={C.blue}
        />
      </div>
    </div>
  );
}

function PaymentsPage() {
  const [showNewPayment, setShowNewPayment] = useState(false);
  const [_payTick, setPayTick] = useState(0);
  const [activeTab, setActiveTab] = useState("Tümü");
  const [search, setSearch]       = useState("");
  const [openPayment, setOpenPayment] = useState(null);
  const { data:repoPays, loading:payLoading, error:payError, reload:reloadPays }
    = useRepo("payment", "getAll");

  const TABS = ["Tümü", "Bekliyor", "Kısmi Ödendi", "Tamamlandı", "İade"];

  const _allPays = repoPays ?? [];
  const filtered = _allPays.filter(p => {
    const tabOk = activeTab === "Tümü"
      || (activeTab === "İade" && p.status === "İade Edildi")
      || p.status === activeTab;
    const srchOk = !search ||
      p.guest.toLowerCase().includes(search.toLowerCase()) ||
      p.resId.toLowerCase().includes(search.toLowerCase()) ||
      p.tour.toLowerCase().includes(search.toLowerCase());
    return tabOk && srchOk;
  });

  const tabCounts = {
    "Tümü":         _allPays.length,
    "Bekliyor":     _allPays.filter(p=>p.status==="Bekliyor").length,
    "Kısmi Ödendi": _allPays.filter(p=>p.status==="Kısmi Ödendi").length,
    "Tamamlandı":   _allPays.filter(p=>p.status==="Tamamlandı").length,
    "İade":         _allPays.filter(p=>p.status==="İade Edildi").length,
  };

  const eurPayments  = _allPays.filter(p=>p.currency==="EUR");
  const totalExp     = eurPayments.reduce((s,p)=>s+p.total, 0);
  const totalColl    = eurPayments.reduce((s,p)=>s+p.paid, 0);
  const totalPending = eurPayments.reduce((s,p)=>s+p.remaining, 0);
  const thisMonth    = eurPayments.filter(p=>!["Bekliyor","İade Edildi"].includes(p.status)).reduce((s,p)=>s+p.paid,0);
  const collPct      = totalExp > 0 ? Math.round(totalColl/totalExp*100) : 0;

  return (
    <>
      {}
      {openPayment && <PaymentDrawer payment={openPayment} onClose={()=>setOpenPayment(null)}/>}
      {showNewPayment ? (<NewPaymentModal onClose={()=>{ setShowNewPayment(false); setPayTick(n=>n+1); reloadPays && reloadPays(); }}/>) : null}

      {payLoading  ? <LoadingState label="Ödemeler yükleniyor…"/> : null}
      {payError   && <ErrorState message={payError} onRetry={reloadPays}/>}
      <div style={{display:"flex", flexDirection:"column", gap:20}}>

        {}
        <div className="page-header" style={{
          background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
          padding:"20px 24px",
          display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:20,
        }}>
          <div>
            <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:5}}>Ödemeler</h1>
            <p style={{margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
              Tüm tahsilatları, kaporaları ve bekleyen ödemeleri yönetin.
            </p>
          </div>
          <div className="page-header-actions" style={{display:"flex", alignItems:"center", gap:10, flexShrink:0}}>
            <div style={{position:"relative"}}>
              <span style={{position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.textFaint, pointerEvents:"none"}}>
                <PIc d="M21 21l-4.35-4.35 M17 11A6 6 0 105 11a6 6 0 0012 0z" size={14} sw={1.8}/>
              </span>
              <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
                placeholder="Misafir veya rezervasyon ara…"
                style={{
                  paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
                  border:`1px solid ${C.border}`, borderRadius:8,
                  background:C.ivory, fontSize:13, color:C.text,
                  fontFamily:"'DM Sans',sans-serif", outline:"none", width:230,
                  transition:"border-color .15s, box-shadow .15s",
                }}
                onFocus={e=>{ e.target.style.borderColor=C.gold; e.target.style.boxShadow=`0 0 0 3px ${C.gold}20`; }}
                onBlur={e=>{ e.target.style.borderColor=C.border; e.target.style.boxShadow="none"; }}
              />
            </div>
            <button style={{
              display:"flex", alignItems:"center", gap:7,
              padding:"9px 16px", borderRadius:8,
              border:"none", background:C.navy, cursor:"pointer", color:C.white,
              fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
            }}
              onMouseEnter={e=>e.currentTarget.style.background=C.navyHover}
              onMouseLeave={e=>e.currentTarget.style.background=C.navy}
            onClick={()=>setShowNewPayment(true)}
          >
              <PIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
              Ödeme Kaydı Ekle
            </button>
          </div>
        </div>

        {}
        <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14}}>
          {[
            {
              label:"Beklenen Toplam Gelir", val:`€${totalExp.toLocaleString("tr-TR")}`,
              sub:"EUR bazlı rezervasyonlar",
              icon:"M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
              color:C.text, iconColor:C.textMuted, iconBg:C.ivoryDark,
              progress:null,
            },
            {
              label:"Tahsil Edilen", val:`€${totalColl.toLocaleString("tr-TR")}`,
              sub:`%${collPct} tahsil edildi`,
              icon:"M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3",
              color:C.green, iconColor:C.green, iconBg:C.greenBg,
              progress:collPct,
            },
            {
              label:"Bekleyen Ödemeler", val:`€${totalPending.toLocaleString("tr-TR")}`,
              sub:`${_allPays.filter(p=>p.remaining>0&&p.currency==="EUR"&&!["İade Edildi"].includes(p.status)).length} rezervasyon`,
              icon:"M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
              color:C.red, iconColor:C.red, iconBg:C.redBg,
              progress:null,
            },
            {
              label:"Bu Ayki Tahsilat", val:`€${thisMonth.toLocaleString("tr-TR")}`,
              sub:new Date().toLocaleDateString("tr-TR",{month:"long",year:"numeric"}),
              icon:"M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z",
              color:C.gold, iconColor:C.gold, iconBg:C.goldPale,
              progress:null,
            },
          ].map((k,i)=>(
            <div key={i} style={{
              background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
              padding:"18px 20px",
            }}>
              <div style={{display:"flex", alignItems:"flex-start", gap:14, marginBottom: k.progress!=null ? 10 : 0}}>
                <div style={{
                  width:42, height:42, borderRadius:10, flexShrink:0,
                  background:k.iconBg, display:"flex", alignItems:"center", justifyContent:"center",
                }}>
                  <PIc d={k.icon} size={18} sw={1.6} color={k.iconColor}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginBottom:4}}>{k.label}</div>
                  <div style={{fontSize:24, fontWeight:700, color:k.color, fontFamily:"'Playfair Display',serif", lineHeight:1}}>{k.val}</div>
                  <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:4}}>{k.sub}</div>
                </div>
              </div>
              {k.progress != null && (
                <div>
                  <div style={{height:5, background:C.ivoryDark, borderRadius:99, overflow:"hidden"}}>
                    <div style={{width:`${k.progress}%`, height:"100%", background:C.green, borderRadius:99}}/>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {}
        <div className="rsp-split" style={{display:"grid", gridTemplateColumns:"1fr 300px", gap:20, alignItems:"start"}}>

          {}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>

            {}
            <div style={{
              display:"flex", alignItems:"center",
              borderBottom:`1px solid ${C.borderLight}`,
              padding:"0 20px", overflowX:"auto",
            }}>
              {TABS.map(tab => {
                const on = activeTab === tab;
                const cnt = tabCounts[tab];
                return (
                  <button key={tab} onClick={()=>setActiveTab(tab)} style={{
                    padding:"13px 14px",
                    border:"none", borderBottom: on ? `2px solid ${C.gold}` : "2px solid transparent",
                    background:"transparent",
                    color: on ? C.gold : C.textMuted,
                    fontFamily:"'DM Sans',sans-serif", fontSize:13,
                    fontWeight: on ? 600 : 400, cursor:"pointer",
                    whiteSpace:"nowrap", marginBottom:-1,
                    display:"flex", alignItems:"center", gap:6,
                    transition:"color .12s",
                  }}>
                    {tab}
                    {cnt > 0 && (
                      <span style={{
                        minWidth:18, height:18, borderRadius:99, padding:"0 5px",
                        display:"inline-flex", alignItems:"center", justifyContent:"center",
                        fontSize:10.5, fontWeight:600,
                        background: on ? `${C.gold}22` : C.ivoryDark,
                        color: on ? C.gold : C.textFaint,
                      }}>{cnt}</span>
                    )}
                  </button>
                );
              })}
              <div style={{marginLeft:"auto", padding:"0 4px", flexShrink:0}}>
                <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{filtered.length} / {_allPays.length} kayıt</span>
              </div>
            </div>

            {}
            {filtered.length === 0 ? (
              <div style={{padding:"60px 40px", textAlign:"center"}}>
                <div style={{fontSize:36, opacity:.2, marginBottom:12}}>💳</div>
                <div style={{fontSize:15, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6}}>Ödeme kaydı bulunamadı.</div>
                <div style={{fontSize:13, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>Bu filtre için kayıt yok.</div>
              </div>
            ) : (
              <>
                <table style={{width:"100%", borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`, background:C.ivory}}>
                      {["Misafir","Rezervasyon","Tur","Toplam","Kapora","Kalan","Son Tarih","Durum",""].map((h,i)=>(
                        <th key={i} style={{
                          padding: i===0 ? "11px 16px 11px 22px" : "11px 12px",
                          textAlign:"left", fontSize:10.5, fontWeight:600,
                          color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
                          textTransform:"uppercase", letterSpacing:"0.07em",
                          whiteSpace:"nowrap",
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((p,i)=>(
                      <PaymentRow key={p.id} p={p} isLast={i===filtered.length-1} onOpen={setOpenPayment}/>
                    ))}
                  </tbody>
                </table>
                <div className="rsp-cards"><MobileCardList items={filtered} renderCard={(p) => {
                  const psm = PAY_STATUS_MAP[p.status]||{color:C.textMuted,bg:C.ivoryDark};
                  const cust = getCustomerById(p.customerId);
                  const sym = p.currency==="TRY"?"₺":"€";
                  return (
                    <MobileCard onClick={()=>setOpenPayment(p)} accent={p.status==="Bekliyor"?C.red:undefined}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                        <div style={{fontSize:15,fontWeight:700,color:C.gold,fontFamily:"'Playfair Display',serif"}}>{sym}{p.amount.toLocaleString("tr-TR")}</div>
                        <span style={{fontSize:11,padding:"2px 7px",borderRadius:99,color:psm.color,background:psm.bg,fontFamily:"'DM Sans',sans-serif",fontWeight:500}}>{p.status}</span>
                      </div>
                      <div style={{fontSize:13,color:C.text,fontFamily:"'DM Sans',sans-serif",marginBottom:3}}>{cust?.name||"—"}</div>
                      <div style={{display:"flex",gap:10}}>
                        <span style={{fontSize:12,color:C.textFaint,fontFamily:"'DM Sans',sans-serif"}}>{p.method}</span>
                        <span style={{fontSize:12,color:C.textFaint,fontFamily:"'DM Mono',monospace"}}>{p.id}</span>
                      </div>
                    </MobileCard>
                  );
                }}/></div>
                <div style={{
                  padding:"11px 20px", background:C.ivory,
                  borderTop:`1px solid ${C.borderLight}`,
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                }}>
                  <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
                    {filtered.length} / {_allPays.length} ödeme kaydı
                  </span>
                  <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
                    Satıra tıklayarak detayları görüntüleyin
                  </span>
                </div>
              </>
            )}
          </div>

          {}
          <PaySidebar payments={_allPays}/>
        </div>
      </div>
    </>
  );
}

const REM_PRIORITY = {
  "Acil":   { color:"#C0392B", bg:"#FDECEC", dot:"#C0392B", order:0 },
  "Yüksek": { color:"#B45309", bg:"#FEF3E2", dot:"#B45309", order:1 },
  "Orta":   { color:"#1A6FAE", bg:"#E8F2FB", dot:"#1A6FAE", order:2 },
  "Düşük":  { color:"#6B7280", bg:"#F3F4F6", dot:"#9CA3AF", order:3 },
};

const REM_STATUS = {
  "Açık":        { color:"#1A6FAE", bg:"#E8F2FB" },
  "Tamamlandı":  { color:"#2E7D52", bg:"#EBF5EF" },
  "Ertelendi":   { color:"#6B7280", bg:"#F3F4F6" },
};

const REM_TYPE_COLOR = {
  "Ödeme Takibi":    { color:"#C05621", bg:"#FEF0E8" },
  "Teklif Takibi":   { color:"#6B3FA0", bg:"#F3EEF9" },
  "Tur Hatırlatma":  { color:"#1B2D4F", bg:"#E5EAF2" },
  "Rehber Atama":    { color:"#B8973A", bg:"#F5EDD4" },
  "Pickup Bilgisi":  { color:"#0E7490", bg:"#ECFEFF" },
  "Müşteri Takibi":  { color:"#2E7D52", bg:"#EBF5EF" },
  "Operasyon Notu":  { color:"#6B7280", bg:"#F3F4F6" },
};

const MOCK_REMINDERS = DB.reminders; // → centralized DB

const ALERTS_STATIC = [
  { level:"acil",   text:"Sarah Johnson için €2.700 ödeme bekleniyor",           icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20" },
  { level:"high",   text:"Emma Brown rezervasyonunda rehber atanmadı",             icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" },
  { level:"high",   text:"Yarın 4 tur bulunuyor — operasyon hazır mı?",           icon:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10" },
  { level:"medium", text:"Yuki Tanaka ve Olivia Carter için pickup bilgisi eksik", icon:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z" },
  { level:"medium", text:"Michael Green teklifine 48 saattir yanıt gelmedi",      icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6" },
];

const AUTOMATIONS = [
  {
    icon:"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z",
    title:"Turdan 24 saat önce WhatsApp",
    desc:"Tur başlamadan 24 saat önce misafire pickup bilgisi ve hazırlık mesajı otomatik gönderilir.",
    trigger:"Tur tarihi − 24 saat", action:"WhatsApp mesajı",
    color:"#128C7E", bg:"#E7F5F3",
  },
  {
    icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75",
    title:"Turdan 3 saat önce rehbere bilgi",
    desc:"Tur başlamadan 3 saat önce atanan rehbere misafir bilgileri ve pickup detayı iletilir.",
    trigger:"Tur tarihi − 3 saat", action:"SMS veya WhatsApp",
    color:"#1A6FAE", bg:"#E8F2FB",
  },
  {
    icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20",
    title:"Geciken ödemede otomatik hatırlatma",
    desc:"Son ödeme tarihi geçmiş rezervasyonlar için misafire ve operasyon ekibine otomatik bildirim.",
    trigger:"Son tarih + 1 gün", action:"E-posta + sistem hatırlatma",
    color:"#C05621", bg:"#FEF0E8",
  },
  {
    icon:"M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z",
    title:"Tur sonrası yorum isteği",
    desc:"Tur tamamlandıktan 24 saat sonra misafire Google ve TripAdvisor yorum isteği gönderilir.",
    trigger:"Tur tamamlandı + 24 saat", action:"E-posta",
    color:"#B8973A", bg:"#F5EDD4",
  },
];

function HIc({ d, size=15, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function HBadge({ label, map, small }) {
  const m = (map||{})[label] || { color:"#6B7280", bg:"#F3F4F6" };
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:4,
      padding: small ? "2px 7px" : "3px 9px",
      borderRadius:99, fontSize: small ? 11 : 11.5, fontWeight:500,
      color:m.color, background:m.bg, whiteSpace:"nowrap",
      fontFamily:"'DM Sans',sans-serif",
    }}>
      {m.dot && <span style={{width:5, height:5, borderRadius:"50%", background:m.dot, flexShrink:0}}/>}
      {label}
    </span>
  );
}

function HTypePill({ label }) {
  const m = REM_TYPE_COLOR[label] || { color:"#6B7280", bg:"#F3F4F6" };
  return (
    <span style={{
      display:"inline-block", padding:"2px 8px", borderRadius:5,
      fontSize:11, fontWeight:500, color:m.color, background:m.bg,
      fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap",
    }}>{label}</span>
  );
}

function HDueLabel({ r }) {
  const done = r.status === "Tamamlandı";
  const overdue = r.dueDateRaw < 0 && !done;
  const today = r.dueDateRaw === 0;
  const tomorrow = r.dueDateRaw === 1;
  const color = done ? C.textFaint : overdue ? C.red : today ? C.amber : C.textMid;
  const label = done ? r.dueDate
    : overdue ? `${Math.abs(r.dueDateRaw)} gün geçti`
    : today ? "Bugün" : tomorrow ? "Yarın" : r.dueDate;
  return (
    <div style={{display:"flex", alignItems:"center", gap:5}}>
      {(overdue || today) && !done && (
        <span style={{width:6, height:6, borderRadius:"50%", background:overdue?C.red:C.amber, flexShrink:0}}/>
      )}
      <span style={{fontSize:12.5, color, fontFamily:"'DM Sans',sans-serif", fontWeight:(overdue||today)&&!done?600:400}}>
        {label}
      </span>
    </div>
  );
}

function ReminderRow({ rem, isLast, onToggle }) {
  const done = rem.status === "Tamamlandı";
  const pMeta = REM_PRIORITY[rem.priority] || {};

  return (
    <tr
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        background:C.white,
        transition:"background .1s",
        opacity: done ? 0.65 : 1,
      }}
    >
      {}
      <td style={{padding:"13px 8px 13px 20px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle", width:40}}>
        <div
          onClick={()=>onToggle(rem.id)}
          style={{
            width:18, height:18, borderRadius:5, cursor:"pointer",
            border: done ? "none" : `1.5px solid ${C.border}`,
            background: done ? C.green : C.white,
            display:"flex", alignItems:"center", justifyContent:"center",
            transition:"all .15s",
          }}
        >
          {done && <HIc d="M20 6L9 17l-5-5" size={11} sw={2.5} color="#fff"/>}
        </div>
      </td>

      {}
      <td style={{padding:"13px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <div style={{display:"flex", alignItems:"flex-start", gap:10}}>
          <div style={{
            width:3, height:36, borderRadius:99, flexShrink:0, marginTop:2,
            background: done ? C.border : pMeta.dot || C.border,
          }}/>
          <div style={{minWidth:0}}>
            <div style={{
              fontSize:13.5, fontWeight:500,
              color: done ? C.textFaint : C.text,
              fontFamily:"'DM Sans',sans-serif",
              textDecoration: done ? "line-through" : "none",
              lineHeight:1.35, marginBottom:3,
            }}>{rem.title}</div>
            <div style={{
              fontSize:11.5, color:C.textFaint,
              fontFamily:"'DM Sans',sans-serif",
              display:"flex", alignItems:"center", gap:6,
            }}>
              <span>{rem.guestFlag} {rem.guest}</span>
              {rem.relatedId && <>
                <span style={{color:C.borderLight}}>·</span>
                <span style={{fontFamily:"'DM Mono',monospace", fontSize:11}}>{rem.relatedId}</span>
              </>}
              <span style={{
                fontSize:10, padding:"1px 5px", borderRadius:3,
                background: rem.source==="otomatik" ? C.blueBg : C.ivoryDark,
                color: rem.source==="otomatik" ? C.blue : C.textFaint,
                fontFamily:"'DM Sans',sans-serif",
              }}>{rem.source}</span>
            </div>
          </div>
        </div>
      </td>

      {}
      <td style={{padding:"13px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <HTypePill label={rem.type}/>
      </td>

      {}
      <td style={{padding:"13px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <HBadge label={rem.priority} map={REM_PRIORITY} small/>
      </td>

      {}
      <td style={{padding:"13px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <HDueLabel r={rem}/>
      </td>

      {}
      <td style={{padding:"13px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        {rem.assigneeInitials ? (
          <div style={{display:"flex", alignItems:"center", gap:7}}>
            <div style={{
              width:24, height:24, borderRadius:"50%",
              background:"rgba(27,45,79,0.09)", border:"1.5px solid rgba(27,45,79,0.14)",
              display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
            }}>
              <span style={{fontSize:9, fontWeight:700, color:C.navy}}>{rem.assigneeInitials}</span>
            </div>
            <span style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"}}>{rem.assignee}</span>
          </div>
        ) : (
          <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontStyle:"italic"}}>Atanmadı</span>
        )}
      </td>

      {}
      <td style={{padding:"13px 16px 13px 8px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
        <HBadge label={rem.status} map={REM_STATUS} small/>
      </td>
    </tr>
  );
}

function RemSidebar() {
  return (
    <div style={{display:"flex", flexDirection:"column", gap:18}}>

      {}
      <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
        <div style={{
          background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
          padding:"16px 18px",
          display:"flex", alignItems:"center", gap:10,
        }}>
          <div style={{
            width:30, height:30, borderRadius:8, flexShrink:0,
            background:"rgba(192,57,43,0.2)", border:"1px solid rgba(192,57,43,0.3)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <HIc d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" size={15} sw={1.8} color="#FF6B6B"/>
          </div>
          <div>
            <div style={{fontSize:13.5, fontWeight:600, color:C.ivory, fontFamily:"'Playfair Display',serif"}}>Operasyon Uyarıları</div>
            <div style={{fontSize:11.5, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Sans',sans-serif"}}>Bugün dikkat edilmesi gerekenler</div>
          </div>
        </div>

        <div style={{padding:"8px 0"}}>
          {ALERTS_STATIC.map((a,i)=>{
            const borderColor = a.level==="acil" ? C.red : a.level==="high" ? C.amber : C.blue;
            const bgColor     = a.level==="acil" ? C.redBg : a.level==="high" ? C.amberBg : C.blueBg;
            return (
              <div key={i}
                onMouseEnter={()=>setHov(true)}
                onMouseLeave={()=>setHov(false)}
                style={{
                  padding:"11px 16px",
                  borderBottom: i<ALERTS_STATIC.length-1 ? `1px solid ${C.borderLight}` : "none",
                  display:"flex", alignItems:"flex-start", gap:10,
                  cursor:"pointer",
                  background:"transparent",
                  transition:"background .1s",
                }}
              >
                <div style={{
                  width:28, height:28, borderRadius:7, flexShrink:0,
                  background:bgColor, border:`1px solid ${borderColor}22`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  color:borderColor,
                }}>
                  <HIc d={a.icon} size={13} sw={1.7} color={borderColor}/>
                </div>
                <div style={{
                  flex:1, fontSize:12.5, color:C.text,
                  fontFamily:"'DM Sans',sans-serif", lineHeight:1.45,
                }}>
                  {a.text}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {}
      <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
        <div style={{
          background:C.ivory, padding:"14px 18px",
          borderBottom:`1px solid ${C.borderLight}`,
          display:"flex", alignItems:"center", justifyContent:"space-between",
        }}>
          <div>
            <div style={{fontSize:13, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>Gelecek Otomasyonlar</div>
            <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2}}>Yakında aktif olacak</div>
          </div>
          <span style={{
            fontSize:10, fontWeight:600, color:C.gold,
            background:C.goldPale, border:`1px solid ${C.gold}44`,
            padding:"2px 8px", borderRadius:99,
            fontFamily:"'DM Sans',sans-serif", letterSpacing:"0.05em",
          }}>YAKINDA</span>
        </div>

        <div style={{padding:"8px 0"}}>
          {AUTOMATIONS.map((a,i)=>(
            <div key={i} style={{
              padding:"12px 16px",
              borderBottom: i<AUTOMATIONS.length-1 ? `1px solid ${C.borderLight}` : "none",
              display:"flex", alignItems:"flex-start", gap:10,
              opacity:0.82,
            }}>
              <div style={{
                width:30, height:30, borderRadius:8, flexShrink:0,
                background:a.bg, display:"flex", alignItems:"center", justifyContent:"center",
                color:a.color,
              }}>
                <HIc d={a.icon} size={14} sw={1.7} color={a.color}/>
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:12.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif", marginBottom:3}}>
                  {a.title}
                </div>
                <div style={{fontSize:11.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", lineHeight:1.45, marginBottom:5}}>
                  {a.desc}
                </div>
                <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
                  <span style={{
                    fontSize:10.5, padding:"1px 6px", borderRadius:4,
                    background:C.ivoryDark, color:C.textMuted,
                    fontFamily:"'DM Sans',sans-serif",
                  }}>⚡ {a.trigger}</span>
                  <span style={{
                    fontSize:10.5, padding:"1px 6px", borderRadius:4,
                    background:a.bg, color:a.color,
                    fontFamily:"'DM Sans',sans-serif",
                  }}>→ {a.action}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{padding:"12px 16px", background:C.ivory, borderTop:`1px solid ${C.borderLight}`}}>
          <div style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", lineHeight:1.6, textAlign:"center"}}>
            Bu otomasyonlar WhatsApp Business API ve<br/>e-posta entegrasyonu tamamlandığında aktif olacak.
          </div>
        </div>
      </div>
    </div>
  );
}

function RemindersPage() {
  const [showNewReminder, setShowNewReminder] = useState(false);
  const [_remTick, setRemTick] = useState(0);
  const [activeTab, setActiveTab] = useState("Tümü");
  const [search, setSearch]       = useState("");
  const { data:repoRems, loading:remsLoading, error:remsError, reload:reloadRems }
    = useRepo("reminder", "getAll");

  const TABS = ["Tümü","Bugün","Bu Hafta","Acil","Tamamlanan","Otomatik","Manuel"];

  async function toggleReminder(id) {
    const repo = getActiveRepo("reminder");
    await Promise.resolve(repo.toggle(id));
    setRemTick(n=>n+1);
    reloadRems && reloadRems();
  }

  const reminders = repoRems ?? [];
  const filtered = reminders.filter(r => {
    if (search && !r.title.toLowerCase().includes(search.toLowerCase()) &&
        !r.guest.toLowerCase().includes(search.toLowerCase())) return false;
    if (activeTab==="Bugün")      return r.dueDateRaw===0 && r.status!=="Tamamlandı";
    if (activeTab==="Bu Hafta")   return r.dueDateRaw>=0 && r.dueDateRaw<=7 && r.status!=="Tamamlandı";
    if (activeTab==="Acil")       return r.priority==="Acil" && r.status!=="Tamamlandı";
    if (activeTab==="Tamamlanan") return r.status==="Tamamlandı";
    if (activeTab==="Otomatik")   return r.source==="otomatik";
    if (activeTab==="Manuel")     return r.source==="manuel";
    return true;
  });

  const sorted = [...filtered].sort((a,b) => {
    if (a.status==="Tamamlandı" && b.status!=="Tamamlandı") return 1;
    if (b.status==="Tamamlandı" && a.status!=="Tamamlandı") return -1;
    const pOrd = (REM_PRIORITY[a.priority]?.order||9) - (REM_PRIORITY[b.priority]?.order||9);
    if (pOrd!==0) return pOrd;
    return a.dueDateRaw - b.dueDateRaw;
  });

  const openCount    = reminders.filter(r=>r.status==="Açık").length;
  const acilCount    = reminders.filter(r=>r.priority==="Acil"&&r.status!=="Tamamlandı").length;
  const todayTours   = 4; // from mock
  const payPending   = reminders.filter(r=>r.type==="Ödeme Takibi"&&r.status==="Açık").length;

  const tabCounts = {
    "Tümü":      reminders.length,
    "Bugün":     reminders.filter(r=>r.dueDateRaw===0&&r.status!=="Tamamlandı").length,
    "Bu Hafta":  reminders.filter(r=>r.dueDateRaw>=0&&r.dueDateRaw<=7&&r.status!=="Tamamlandı").length,
    "Acil":      acilCount,
    "Tamamlanan":reminders.filter(r=>r.status==="Tamamlandı").length,
    "Otomatik":  reminders.filter(r=>r.source==="otomatik").length,
    "Manuel":    reminders.filter(r=>r.source==="manuel").length,
  };

  return (
    <>
    {showNewReminder ? (<NewReminderModal onClose={()=>{ setShowNewReminder(false); setRemTick(n=>n+1); }}/>) : null}
    <div style={{display:"flex", flexDirection:"column", gap:20}}>

      {}
      <div className="page-header" style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"20px 24px",
        display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:20,
      }}>
        <div>
          <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:5}}>Hatırlatmalar</h1>
          <p style={{margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
            Operasyon, satış ve ödeme süreçlerini takip edin.
          </p>
        </div>
        <div className="page-header-actions" style={{display:"flex", alignItems:"center", gap:10, flexShrink:0}}>
          <div style={{position:"relative"}}>
            <span style={{position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.textFaint, pointerEvents:"none"}}>
              <HIc d="M21 21l-4.35-4.35 M17 11A6 6 0 105 11a6 6 0 0012 0z" size={14} sw={1.8}/>
            </span>
            <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Hatırlatma veya misafir ara…"
              style={{
                paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
                border:`1px solid ${C.border}`, borderRadius:8,
                background:C.ivory, fontSize:13, color:C.text,
                fontFamily:"'DM Sans',sans-serif", outline:"none", width:"min(220px,45vw)",
                transition:"border-color .15s, box-shadow .15s",
              }}
              onFocus={e=>{ e.target.style.borderColor=C.gold; e.target.style.boxShadow=`0 0 0 3px ${C.gold}20`; }}
              onBlur={e=>{ e.target.style.borderColor=C.border; e.target.style.boxShadow="none"; }}
            />
          </div>
          <button style={{
            display:"flex", alignItems:"center", gap:7,
            padding:"9px 16px", borderRadius:8,
            border:"none", background:C.navy, cursor:"pointer", color:C.white,
            fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.navyHover}
            onMouseLeave={e=>e.currentTarget.style.background=C.navy}
          onClick={()=>setShowNewReminder(true)}
          >
            <HIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
            Hatırlatma Ekle
          </button>
        </div>
      </div>

      {}
      <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14}}>
        {[
          { label:"Açık Hatırlatmalar",  val:openCount,   icon:"M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0", color:C.blue,  bg:C.blueBg,  sub:`${reminders.length} toplam` },
          { label:"Acil Uyarılar",       val:acilCount,   icon:"M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z", color:C.red,   bg:C.redBg,   sub:"Hemen ilgilenilmeli" },
          { label:"Yarınki Turlar",      val:todayTours,  icon:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10", color:C.amber, bg:C.amberBg, sub:"04 Haziran 2026" },
          { label:"Ödeme Hatırlatması",  val:payPending,  icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20", color:C.orange,bg:C.orangeBg,sub:"Ödeme takibi gerekli" },
        ].map((k,i)=>(
          <div key={i} style={{
            background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
            padding:"18px 20px", display:"flex", alignItems:"flex-start", gap:14,
          }}>
            <div style={{
              width:42, height:42, borderRadius:10, flexShrink:0,
              background:k.bg, display:"flex", alignItems:"center", justifyContent:"center",
            }}>
              <HIc d={k.icon} size={18} sw={1.6} color={k.color}/>
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:26, fontWeight:700, color:k.color, fontFamily:"'Playfair Display',serif", lineHeight:1, marginBottom:4}}>{k.val}</div>
              <div style={{fontSize:12, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginBottom:2}}>{k.label}</div>
              <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{k.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {}
      <div className="rsp-split" style={{display:"grid", gridTemplateColumns:"1fr 300px", gap:20, alignItems:"start"}}>

        {}
        <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>

          {}
          <div style={{
            display:"flex", alignItems:"center",
            borderBottom:`1px solid ${C.borderLight}`,
            padding:"0 20px", overflowX:"auto",
          }}>
            {TABS.map(tab => {
              const on = activeTab===tab;
              const cnt = tabCounts[tab];
              return (
                <button key={tab} onClick={()=>setActiveTab(tab)} style={{
                  padding:"12px 13px",
                  border:"none", borderBottom: on?`2px solid ${C.gold}`:"2px solid transparent",
                  background:"transparent",
                  color: on?C.gold:C.textMuted,
                  fontFamily:"'DM Sans',sans-serif", fontSize:12.5,
                  fontWeight: on?600:400, cursor:"pointer",
                  whiteSpace:"nowrap", marginBottom:-1,
                  display:"flex", alignItems:"center", gap:5,
                  transition:"color .12s",
                }}>
                  {tab}
                  {cnt>0 && (
                    <span style={{
                      minWidth:17, height:17, borderRadius:99, padding:"0 4px",
                      display:"inline-flex", alignItems:"center", justifyContent:"center",
                      fontSize:10, fontWeight:600,
                      background: on?`${C.gold}22`:C.ivoryDark,
                      color: on?C.gold:C.textFaint,
                    }}>{cnt}</span>
                  )}
                </button>
              );
            })}
            <div style={{marginLeft:"auto", padding:"0 4px", flexShrink:0}}>
              <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{sorted.length} hatırlatma</span>
            </div>
          </div>

          {}
          {sorted.length===0 ? (
            <div style={{padding:"60px 40px", textAlign:"center"}}>
              <div style={{fontSize:36, opacity:.2, marginBottom:12}}>🔔</div>
              <div style={{fontSize:15, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6}}>
                Henüz hatırlatma bulunmuyor.
              </div>
              <div style={{fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
                Bu filtre için kayıt yok.
              </div>
            </div>
          ) : (
            <>
              <table style={{width:"100%", borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{borderBottom:`1px solid ${C.border}`, background:C.ivory}}>
                    <th style={{padding:"10px 8px 10px 20px", width:40}}/>
                    {["Hatırlatma","Kategori","Öncelik","Tarih","Sorumlu","Durum"].map((h,i)=>(
                      <th key={h} style={{
                        padding:"10px 12px",
                        textAlign:"left", fontSize:10.5, fontWeight:600,
                        color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
                        textTransform:"uppercase", letterSpacing:"0.07em",
                        whiteSpace:"nowrap",
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((rem,i)=>(
                    <ReminderRow
                      key={rem.id} rem={rem}
                      isLast={i===sorted.length-1}
                      onToggle={toggleReminder}
                    />
                  ))}
                </tbody>
              </table>
            <div className="rsp-cards"><MobileCardList items={filtered} renderCard={(item,i)=>(
                <MobileCard key={item.id}>
                  <div>
                    <div style={{fontWeight:600,fontSize:14,color:C.text}}>{item.title}</div>
                    <div style={{fontSize:12,color:C.textMuted,marginTop:2}}>{item.dueDate||"—"}</div>
                  </div>
                </MobileCard>
              )}/></div>

              <div style={{
                padding:"10px 20px", background:C.ivory,
                borderTop:`1px solid ${C.borderLight}`,
                display:"flex", alignItems:"center", justifyContent:"space-between",
              }}>
                <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
                  {sorted.length} / {reminders.length} hatırlatma
                </span>
                <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
                  Checkbox ile tamamlandı olarak işaretle
                </span>
              </div>
            </>
          )}
        </div>

        {}
        <RemSidebar/>
      </div>
    </div>
    </>
  );
}

const TOUR_STATUS_CFG = {
  "Aktif":  { color:"#2E7D52", bg:"#EBF5EF", dot:"#2E7D52" },
  "Taslak": { color:"#B8973A", bg:"#F5EDD4", dot:"#B8973A" },
  "Arşiv":  { color:"#6B7280", bg:"#F3F4F6", dot:"#9CA3AF" },
};
const TOUR_CATEGORY_CFG = {
  "Özel Tur":     { color:"#1B2D4F", bg:"#E5EAF2" },
  "Tekne Turu":   { color:"#0E7490", bg:"#ECFEFF" },
  "Kültürel Tur": { color:"#6B3FA0", bg:"#F3EEF9" },
  "Macera Turu":  { color:"#B45309", bg:"#FEF3E2" },
  "Gastronomi":   { color:"#C05621", bg:"#FEF0E8" },
  "Gün Turu":     { color:"#2E7D52", bg:"#EBF5EF" },
};

const MOCK_TOURS = DB.tours; // → centralized DB

function URIc({ d, size=15, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function TourStatusBadge({ status }) {
  const m = TOUR_STATUS_CFG[status] || {};
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding:"4px 10px", borderRadius:99,
      fontSize:11.5, fontWeight:500,
      color:m.color, background:m.bg,
      fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap",
    }}>
      <span style={{width:6, height:6, borderRadius:"50%", background:m.dot}}/>
      {status}
    </span>
  );
}

function TourCatPill({ category }) {
  const m = TOUR_CATEGORY_CFG[category] || { color:"#6B7280", bg:"#F3F4F6" };
  return (
    <span style={{
      display:"inline-block", padding:"2px 9px", borderRadius:5,
      fontSize:11.5, fontWeight:500,
      color:m.color, background:m.bg,
      fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap",
    }}>{category}</span>
  );
}

function TourChecklist({ items, setItems, accent }) {
  const [newVal, setNewVal] = useState("");
  function toggle(i) { setItems(p=>p.map((x,j)=>j===i?{...x,on:!x.on}:x)); }
  function remove(i) { setItems(p=>p.filter((_,j)=>j!==i)); }
  function add()     { if(newVal.trim()){ setItems(p=>[...p,{label:newVal.trim(),on:true}]); setNewVal(""); } }
  return (
    <div>
      {items.map((it,i)=>(
        <div key={i} style={{
          display:"flex", alignItems:"center", gap:9,
          padding:"8px 0", borderBottom:`1px solid ${C.borderLight}`,
        }}>
          <div onClick={()=>toggle(i)} style={{
            width:18, height:18, borderRadius:4, flexShrink:0, cursor:"pointer",
            border: it.on?"none":`1.5px solid ${C.border}`,
            background: it.on?(accent||C.green):C.white,
            display:"flex", alignItems:"center", justifyContent:"center",
            transition:"background .15s",
          }}>
            {it.on && <URIc d="M20 6L9 17l-5-5" size={11} sw={2.5} color="#fff"/>}
          </div>
          <span style={{
            flex:1, fontSize:13, fontFamily:"'DM Sans',sans-serif",
            color:it.on?C.text:C.textFaint,
            textDecoration:it.on?"none":"line-through",
          }}>{it.label}</span>
          <button onClick={()=>remove(i)} style={{
            background:"none", border:"none", cursor:"pointer", color:C.textFaint, padding:2,
          }}>
            <URIc d="M18 6L6 18M6 6l12 12" size={13} sw={2}/>
          </button>
        </div>
      ))}
      <div style={{display:"flex", gap:7, marginTop:10}}>
        <input value={newVal} onChange={e=>setNewVal(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&add()}
          placeholder="Yeni öğe ekle…"
          style={{
            flex:1, padding:"7px 10px",
            border:`1px solid ${C.border}`, borderRadius:6,
            background:C.ivory, fontSize:12.5, color:C.text,
            fontFamily:"'DM Sans',sans-serif", outline:"none", boxSizing:"border-box",
          }}/>
        <button onClick={add} style={{
          padding:"7px 14px", borderRadius:6, cursor:"pointer",
          background:C.navy, border:"none", color:C.white,
          fontSize:12, fontFamily:"'DM Sans',sans-serif", fontWeight:500,
        }}>+ Ekle</button>
      </div>
    </div>
  );
}

function TourQuotePreview({ tour, paxCount, incItems }) {
  const sym = tour.currency==="TRY"?"₺":"€";
  const price = tour.pricingType==="Sabit Fiyat"
    ? tour.flatPrice
    : (tour.tiers?.[paxCount] || tour.basePrice * paxCount);
  const incOn = incItems.filter(x=>x.on);
  return (
    <div style={{
      background:"#F8F5EE", borderRadius:10, border:`1px solid ${C.border}`,
      overflow:"hidden", fontSize:12.5,
    }}>
      {}
      <div style={{
        background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
        padding:"14px 18px",
      }}>
        <div style={{fontSize:10, color:"rgba(248,245,238,0.5)", letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:4, fontFamily:"'DM Sans',sans-serif"}}>TEKLİFTE GÖRÜNÜM</div>
        <div style={{fontSize:16, fontWeight:700, color:C.ivory, fontFamily:"'Playfair Display',serif"}}>{tour.name}</div>
        <div style={{fontSize:12, color:"rgba(248,245,238,0.55)", marginTop:3, fontFamily:"'DM Sans',sans-serif"}}>
          {tour.duration} · {tour.category}
        </div>
      </div>
      <div style={{padding:"14px 18px"}}>
        {}
        <div style={{
          background:C.white, borderRadius:8, padding:"12px 14px", marginBottom:12,
          border:`1px solid ${C.borderLight}`,
        }}>
          <div style={{fontSize:10.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:8}}>Fiyat Hesabı</div>
          {tour.pricingType==="Kişi Bazlı" ? (
            <>
              <div style={{display:"flex", justifyContent:"space-between", marginBottom:4}}>
                <span style={{fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>Kişi Başı</span>
                <span style={{fontSize:12.5, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{sym}{tour.tiers?.[paxCount] ? Math.round(tour.tiers[paxCount]/paxCount) : tour.basePrice}</span>
              </div>
              <div style={{display:"flex", justifyContent:"space-between", marginBottom:8}}>
                <span style={{fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>Kişi Sayısı</span>
                <span style={{fontSize:12.5, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>× {paxCount}</span>
              </div>
            </>
          ) : (
            <div style={{display:"flex", justifyContent:"space-between", marginBottom:8}}>
              <span style={{fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>Sabit Fiyat</span>
              <span style={{fontSize:12.5, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{sym}{tour.flatPrice}</span>
            </div>
          )}
          <div style={{height:1, background:C.borderLight, marginBottom:8}}/>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline"}}>
            <span style={{fontSize:13, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>Toplam</span>
            <span style={{fontSize:20, fontWeight:700, color:C.gold, fontFamily:"'Playfair Display',serif"}}>{sym}{price}</span>
          </div>
        </div>
        {}
        <div>
          <div style={{fontSize:10.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:7}}>Dahil Hizmetler</div>
          {incOn.slice(0,4).map((s,i)=>(
            <div key={i} style={{display:"flex", gap:7, alignItems:"flex-start", marginBottom:5}}>
              <URIc d="M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3" size={13} sw={2} color={C.green}/>
              <span style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{s.label}</span>
            </div>
          ))}
          {incOn.length > 4 && (
            <div style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", paddingLeft:20}}>+{incOn.length-4} daha…</div>
          )}
        </div>
      </div>
    </div>
  );
}

function TourDetailPage({ tourId, onBack }) {
  const _sp = safeParam(tourId);
  if (_sp.invalid) return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:60,gap:16}}>
      <div style={{fontSize:36}}>🔍</div>
      <div style={{fontSize:16,fontWeight:600,color:'#1B2D4F',fontFamily:"'Playfair Display',serif"}}>Kayıt bulunamadı</div>
      <div style={{fontSize:13,color:'#6B7280'}}>
        {_sp.reason==='demo' ? 'Bu demo kayıt Supabase modunda görüntülenemez.' : 'Geçersiz kayıt kimliği.'}
      </div>
      <button onClick={onBack} style={{padding:'9px 20px',borderRadius:8,border:'none',background:'#1B2D4F',color:'#fff',cursor:'pointer',fontSize:13}}>Geri Dön</button>
    </div>
  );

  const { data:orig, loading:tdLoading, error:tdError } = useRepo("tour", "getById", tourId);
  const { mutate:mutTour, mutating:tourSaving } = useRepoMutation("tour");

  const [name,     setName]     = useState("");
  const [category, setCategory] = useState("Kültür & Tarih");
  const [duration, setDuration] = useState(1);
  const [desc,     setDesc]     = useState("");
  const [status,   setStatus]   = useState("Aktif");
  const [pricingType, setPricingType] = useState("flat");
  const [flatPrice,   setFlatPrice]   = useState(0);
  const [saved,    setSaved]    = useState(false);
  const [currency, setCurrency] = useState("EUR");

  useEffect(() => {
    if (orig) {
      setName(orig.name || "");
      setCategory(orig.category || "Kültür & Tarih");
      setDuration(orig.duration || 1);
      setDesc(orig.description || "");
      setStatus(orig.status || "Aktif");
      setPricingType(orig.pricingType || "flat");
      setFlatPrice(orig.flatPrice || 0);
      setCurrency(orig.currency || "EUR");
    }
  }, [orig?.id]);

  if (tdLoading) return <LoadingState label="Tur yükleniyor…"/>;
  if (tdError)   return <ErrorState message={tdError} onRetry={()=>{}}/>;
  if (!orig)     return <NotFound404 onBack={onBack}/>;

  const [tiers,    setTiers]    = useState(orig?.tiers||{1:180,2:240,3:300,4:360,5:420,6:480,7:520,8:560});
  const [included, setIncluded] = useState((orig?.included||[]).map(l=>({label:l,on:true})));
  const [excluded, setExcluded] = useState(orig?.excluded||[]);
  const [ops,      setOps]      = useState(orig?.ops||[]);
  const [paxPreview, setPaxPreview] = useState(4);

  const sym = currency==="TRY"?"₺":"€";
  const previewTour = {...orig, name, category, duration, pricingType, flatPrice, tiers, currency};

  async function handleSave() {
    const errs = validate({
      name:{ required:"Tur adı zorunludur", minLen:2 },
    }, { name });
    if (Object.keys(errs).length) { showToast(errs.name || "Form hatası"); return; }
    const { error } = await mutTour("update", orig.id, {
      name, category, duration: parseInt(duration)||1,
      description: desc, status, pricingType,
      flatPrice: parseFloat(flatPrice)||0, currency,
    });
    if (error) { showToast("Kaydedilemedi: " + error); return; }
    setSaved(true);
    showToast("Tur kaydedildi ✓");
    setTimeout(() => setSaved(false), 2400);
  }

  const CATEGORIES = Object.keys(TOUR_CATEGORY_CFG);
  const CURRENCIES = ["EUR","USD","TRY","GBP"];

  function Field({ label, children }) {
    return (
      <div style={{marginBottom:16}}>
        <div style={{fontSize:10.5, fontWeight:600, color:C.textFaint, textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:"'DM Sans',sans-serif", marginBottom:6}}>{label}</div>
        {children}
      </div>
    );
  }
  function TInput({ value, onChange, placeholder, type="text" }) {
    const [foc,setFoc]=useState(false);
    return (
      <input type={type} value={value} onChange={e=>onChange(e.target.value)}
        placeholder={placeholder}
        onFocus={()=>setFoc(true)} onBlur={()=>setFoc(false)}
        style={{
          width:"100%", padding:"9px 12px", boxSizing:"border-box",
          border:`1px solid ${foc?C.gold:C.border}`, borderRadius:7,
          background:C.ivory, fontSize:13, color:C.text,
          fontFamily:"'DM Sans',sans-serif", outline:"none",
          boxShadow:foc?`0 0 0 3px ${C.gold}18`:"none",
          transition:"border-color .15s, box-shadow .15s",
        }}/>
    );
  }
  function TSelect({ value, onChange, options }) {
    return (
      <select value={value} onChange={e=>onChange(e.target.value)} style={{
        width:"100%", padding:"9px 12px", boxSizing:"border-box",
        border:`1px solid ${C.border}`, borderRadius:7,
        background:C.ivory, fontSize:13, color:C.text,
        fontFamily:"'DM Sans',sans-serif", outline:"none", cursor:"pointer",
      }}>
        {options.map(o=><option key={o}>{o}</option>)}
      </select>
    );
  }

  return (
    <div style={{display:"flex", flexDirection:"column", gap:20}}>

      {}
      <div style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"15px 22px",
        display:"flex", alignItems:"center", justifyContent:"space-between", gap:16,
      }}>
        <div style={{display:"flex", alignItems:"center", gap:14}}>
          <button onClick={onBack} style={{
            display:"flex", alignItems:"center", gap:6,
            background:C.ivory, border:`1px solid ${C.border}`,
            borderRadius:7, padding:"6px 12px", cursor:"pointer",
            color:C.textMid, fontFamily:"'DM Sans',sans-serif", fontSize:12.5,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.ivoryDark}
            onMouseLeave={e=>e.currentTarget.style.background=C.ivory}
          >
            <URIc d="M15 18l-6-6 6-6" size={13} sw={2}/>
            Turlar
          </button>
          <div style={{width:1, height:20, background:C.borderLight}}/>
          <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Mono',monospace", background:C.ivory, border:`1px solid ${C.borderLight}`, padding:"3px 8px", borderRadius:5}}>{orig.id}</span>
          <div>
            <div style={{fontSize:16, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", lineHeight:1.2}}>{name}</div>
            <div style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2}}>{category} · {duration}</div>
          </div>
        </div>
        <div style={{display:"flex", alignItems:"center", gap:8, flexShrink:0}}>
          <TourStatusBadge status={status}/>
          <div style={{width:1, height:20, background:C.borderLight}}/>
          {}
          {[
            { label:"Önizle",          icon:"M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" },
            { label:"Teklifte Kullan", icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8" },
            { label:"Arşivle",         icon:"M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
          ].map((a,i)=>(
            <button key={i} style={{
              display:"flex", alignItems:"center", gap:6,
              padding:"7px 13px", borderRadius:7,
              border:`1px solid ${C.border}`, background:C.white,
              cursor:"pointer", color:C.textMid,
              fontFamily:"'DM Sans',sans-serif", fontSize:12.5,
              transition:"background .1s",
            }}
              onMouseEnter={e=>{ e.currentTarget.style.background=C.ivory; e.currentTarget.style.color=C.text; }}
              onMouseLeave={e=>{ e.currentTarget.style.background=C.white; e.currentTarget.style.color=C.textMid; }}
            >
              <URIc d={a.icon} size={13} sw={1.7}/>
              {a.label}
            </button>
          ))}
          <button onClick={handleSave} style={{
            display:"flex", alignItems:"center", gap:7,
            padding:"8px 18px", borderRadius:7,
            border:"none", background: saved ? C.green : C.navy,
            cursor:"pointer", color:C.white,
            fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:600,
            transition:"background .2s",
          }}>
            <URIc d={saved?"M20 6L9 17l-5-5":"M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v14a2 2 0 01-2 2z M17 21v-8H7v8 M7 3v5h8"} size={14} sw={2}/>
            {saved ? "Kaydedildi ✓" : "Kaydet"}
          </button>
        </div>
      </div>

      {}
      <div style={{display:"grid", gridTemplateColumns: window.innerWidth < 768 ? "1fr" : "1fr 340px", gap:20, alignItems:"start"}}>

        {}
        <div style={{display:"flex", flexDirection:"column", gap:18}}>

          {}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
            <div style={{padding:"13px 20px", background:C.ivory, borderBottom:`1px solid ${C.borderLight}`, display:"flex", alignItems:"center", gap:8}}>
              <div style={{width:22, height:22, borderRadius:"50%", background:C.navy, display:"flex", alignItems:"center", justifyContent:"center"}}>
                <span style={{fontSize:11, fontWeight:700, color:C.goldLight, fontFamily:"'DM Sans',sans-serif"}}>1</span>
              </div>
              <span style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>Genel Bilgiler</span>
            </div>
            <div style={{padding:"20px"}}>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14}}>
                <Field label="Tur Adı"><TInput value={name} onChange={setName} placeholder="Tur adı"/></Field>
                <Field label="Kategori"><TSelect value={category} onChange={setCategory} options={CATEGORIES}/></Field>
                <Field label="Süre"><TInput value={duration} onChange={setDuration} placeholder="8 Saat"/></Field>
                <Field label="Durum">
                  <div style={{display:"flex", gap:8}}>
                    {["Aktif","Taslak","Arşiv"].map(s=>{
                      const m = TOUR_STATUS_CFG[s];
                      const on = status===s;
                      return (
                        <button key={s} onClick={()=>setStatus(s)} style={{
                          flex:1, padding:"8px 0", borderRadius:7, cursor:"pointer",
                          border: on?`1.5px solid ${m.color}`:`1px solid ${C.border}`,
                          background: on?m.bg:C.white,
                          color: on?m.color:C.textMid,
                          fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:on?600:400,
                          transition:"all .12s",
                        }}>{s}</button>
                      );
                    })}
                  </div>
                </Field>
              </div>
              <Field label="Kısa Açıklama">
                <textarea value={desc} onChange={e=>setDesc(e.target.value)} rows={3} style={{
                  width:"100%", padding:"9px 12px", boxSizing:"border-box",
                  border:`1px solid ${C.border}`, borderRadius:7,
                  background:C.ivory, fontSize:13, color:C.text,
                  fontFamily:"'DM Sans',sans-serif", outline:"none", resize:"vertical", lineHeight:1.6,
                }}/>
              </Field>
            </div>
          </div>

          {}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
            <div style={{padding:"13px 20px", background:C.ivory, borderBottom:`1px solid ${C.borderLight}`, display:"flex", alignItems:"center", gap:8}}>
              <div style={{width:22, height:22, borderRadius:"50%", background:C.navy, display:"flex", alignItems:"center", justifyContent:"center"}}>
                <span style={{fontSize:11, fontWeight:700, color:C.goldLight, fontFamily:"'DM Sans',sans-serif"}}>2</span>
              </div>
              <span style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>Fiyatlandırma</span>
            </div>
            <div style={{padding:"20px"}}>
              {}
              <div style={{display:"flex", gap:10, marginBottom:20}}>
                {[
                  {k:"Kişi Bazlı", icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75"},
                  {k:"Sabit Fiyat",icon:"M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 11h.01M12 11h.01M15 11h.01M9 7h6m0 10v-3m-3 3h.01"},
                ].map(({k,icon})=>{
                  const on = pricingType===k;
                  return (
                    <button key={k} onClick={()=>setPricingType(k)} style={{
                      flex:1, padding:"12px 16px", borderRadius:9, cursor:"pointer",
                      border: on?`1.5px solid ${C.gold}`:`1px solid ${C.border}`,
                      background: on?C.goldPale:C.white,
                      display:"flex", flexDirection:"column", alignItems:"center", gap:7,
                      transition:"all .12s",
                    }}>
                      <URIc d={icon} size={20} sw={1.5} color={on?C.gold:C.textFaint}/>
                      <span style={{fontSize:13, fontWeight:on?600:400, color:on?C.gold:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{k}</span>
                    </button>
                  );
                })}
              </div>

              {}
              <div style={{marginBottom:16}}>
                <div style={{fontSize:10.5, fontWeight:600, color:C.textFaint, textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:"'DM Sans',sans-serif", marginBottom:6}}>Para Birimi</div>
                <div style={{display:"flex", gap:8}}>
                  {CURRENCIES.map(cur=>(
                    <button key={cur} onClick={()=>setCurrency(cur)} style={{
                      padding:"7px 16px", borderRadius:7, cursor:"pointer",
                      border: cur===currency?`1.5px solid ${C.gold}`:`1px solid ${C.border}`,
                      background: cur===currency?C.goldPale:C.white,
                      color: cur===currency?C.gold:C.textMid,
                      fontSize:13, fontWeight:cur===currency?600:400,
                      fontFamily:"'DM Sans',sans-serif", transition:"all .12s",
                    }}>{cur}</button>
                  ))}
                </div>
              </div>

              {pricingType==="Sabit Fiyat" ? (
                <div>
                  <div style={{fontSize:10.5, fontWeight:600, color:C.textFaint, textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:"'DM Sans',sans-serif", marginBottom:6}}>Sabit Fiyat</div>
                  <div style={{position:"relative", maxWidth:200}}>
                    <span style={{position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:C.textFaint, fontSize:14, pointerEvents:"none"}}>{sym}</span>
                    <input type="number" value={flatPrice} onChange={e=>setFlatPrice(Number(e.target.value))} style={{
                      width:"100%", padding:"10px 12px 10px 28px", boxSizing:"border-box",
                      border:`1px solid ${C.border}`, borderRadius:7,
                      background:C.ivory, fontSize:16, fontWeight:700, color:C.text,
                      fontFamily:"'Playfair Display',serif", outline:"none",
                    }}/>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{fontSize:10.5, fontWeight:600, color:C.textFaint, textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:"'DM Sans',sans-serif", marginBottom:8}}>Kişi Bazlı Fiyat Tablosu</div>
                  <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8}}>
                    {Object.entries(tiers).map(([n,p])=>(
                      <div key={n} style={{
                        background:C.ivory, borderRadius:8, padding:"10px 12px",
                        border:`1px solid ${C.borderLight}`,
                        textAlign:"center",
                      }}>
                        <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginBottom:5}}>{n} kişi</div>
                        <div style={{position:"relative"}}>
                          <span style={{position:"absolute", left:6, top:"50%", transform:"translateY(-50%)", color:C.textFaint, fontSize:11, pointerEvents:"none"}}>{sym}</span>
                          <input type="number" value={p}
                            onChange={e=>setTiers(prev=>({...prev,[n]:Number(e.target.value)}))}
                            style={{
                              width:"100%", padding:"5px 6px 5px 18px", boxSizing:"border-box",
                              border:`1px solid ${C.border}`, borderRadius:5,
                              background:C.white, fontSize:14, fontWeight:700, color:C.gold,
                              fontFamily:"'Playfair Display',serif", outline:"none", textAlign:"center",
                            }}/>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {}
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:18}}>
            {[
              {n:"3", title:"Dahil Olanlar",    items:included, setItems:setIncluded, accent:C.green},
              {n:"4", title:"Dahil Olmayanlar", items:excluded,  setItems:setExcluded, accent:C.red},
            ].map(sec=>(
              <div key={sec.n} style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
                <div style={{padding:"13px 20px", background:C.ivory, borderBottom:`1px solid ${C.borderLight}`, display:"flex", alignItems:"center", gap:8}}>
                  <div style={{width:22, height:22, borderRadius:"50%", background:C.navy, display:"flex", alignItems:"center", justifyContent:"center"}}>
                    <span style={{fontSize:11, fontWeight:700, color:C.goldLight, fontFamily:"'DM Sans',sans-serif"}}>{sec.n}</span>
                  </div>
                  <span style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>{sec.title}</span>
                </div>
                <div style={{padding:"16px 20px"}}>
                  <TourChecklist items={sec.items} setItems={sec.setItems} accent={sec.accent}/>
                </div>
              </div>
            ))}
          </div>

          {}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
            <div style={{padding:"13px 20px", background:C.ivory, borderBottom:`1px solid ${C.borderLight}`, display:"flex", alignItems:"center", gap:8}}>
              <div style={{width:22, height:22, borderRadius:"50%", background:C.navy, display:"flex", alignItems:"center", justifyContent:"center"}}>
                <span style={{fontSize:11, fontWeight:700, color:C.goldLight, fontFamily:"'DM Sans',sans-serif"}}>5</span>
              </div>
              <span style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>Operasyon Ayarları</span>
            </div>
            <div style={{padding:"20px"}}>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:16}}>
                {[
                  {k:"pickup", label:"Pickup Gerekli", icon:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z"},
                  {k:"vehicle", label:"Araç Gerekli",  icon:"M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z M13 17H9m4 0h2m2-5H3M5 12V5h14v7"},
                  {k:"guide",  label:"Rehber Gerekli", icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75"},
                ].map(o=>{
                  const on = ops[o.k];
                  return (
                    <div key={o.k}
                      onClick={()=>setOps(prev=>({...prev,[o.k]:!prev[o.k]}))}
                      style={{
                        padding:"12px 14px", borderRadius:9, cursor:"pointer",
                        border: on?`1.5px solid ${C.navy}`:`1px solid ${C.border}`,
                        background: on?`rgba(27,45,79,0.06)`:C.white,
                        display:"flex", flexDirection:"column", alignItems:"center", gap:6,
                        transition:"all .12s",
                      }}>
                      <URIc d={o.icon} size={20} sw={1.5} color={on?C.navy:C.textFaint}/>
                      <span style={{fontSize:12.5, fontWeight:on?600:400, color:on?C.navy:C.textMid, fontFamily:"'DM Sans',sans-serif", textAlign:"center"}}>{o.label}</span>
                      <div style={{
                        width:32, height:18, borderRadius:99, position:"relative",
                        background: on?C.navy:C.borderLight, transition:"background .15s",
                      }}>
                        <div style={{
                          width:14, height:14, borderRadius:"50%", background:C.white,
                          position:"absolute", top:2, left: on?16:2,
                          transition:"left .15s", boxShadow:"0 1px 3px rgba(0,0,0,0.2)",
                        }}/>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div>
                <div style={{fontSize:10.5, fontWeight:600, color:C.textFaint, textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:"'DM Sans',sans-serif", marginBottom:6}}>Varsayılan Notlar</div>
                <textarea value={ops.defaultNotes} onChange={e=>setOps(p=>({...p,defaultNotes:e.target.value}))} rows={2} style={{
                  width:"100%", padding:"9px 12px", boxSizing:"border-box",
                  border:`1px solid ${C.border}`, borderRadius:7,
                  background:C.ivory, fontSize:13, color:C.text,
                  fontFamily:"'DM Sans',sans-serif", outline:"none", resize:"vertical", lineHeight:1.6,
                }}/>
              </div>
            </div>
          </div>
        </div>

        {}
        <div style={{position:"sticky", top:20, display:"flex", flexDirection:"column", gap:16}}>
          {}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px"}}>
            <div style={{fontSize:11, fontWeight:600, color:C.textFaint, textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:"'DM Sans',sans-serif", marginBottom:10}}>
              6. Teklif Önizleme
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:12, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginBottom:6}}>Kişi sayısı seç:</div>
              <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
                {[1,2,3,4,5,6,7,8].map(n=>(
                  <button key={n} onClick={()=>setPaxPreview(n)} style={{
                    width:34, height:32, borderRadius:6, cursor:"pointer",
                    border: n===paxPreview?`1.5px solid ${C.gold}`:`1px solid ${C.border}`,
                    background: n===paxPreview?C.goldPale:C.white,
                    color: n===paxPreview?C.gold:C.textMid,
                    fontSize:13, fontWeight:n===paxPreview?700:400,
                    fontFamily:"'DM Sans',sans-serif", transition:"all .12s",
                  }}>{n}</button>
                ))}
              </div>
            </div>
            <TourQuotePreview tour={previewTour} paxCount={paxPreview} incItems={included}/>
          </div>

          {}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
            <div style={{padding:"13px 18px", background:C.ivory, borderBottom:`1px solid ${C.borderLight}`}}>
              <span style={{fontSize:11, fontWeight:600, color:C.textFaint, textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:"'DM Sans',sans-serif"}}>Tur İstatistikleri</span>
            </div>
            <div style={{padding:"4px 0"}}>
              {[
                { label:"Toplam Kullanım", val:`${orig.usageCount} teklif/rezervasyon` },
                { label:"Son Güncelleme",  val:orig.updatedAt },
                { label:"Fiyatlandırma",   val:pricingType },
                { label:"Para Birimi",     val:currency },
              ].map((r,i,arr)=>(
                <div key={i} style={{
                  display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"10px 18px",
                  borderBottom: i<arr.length-1?`1px solid ${C.borderLight}`:"none",
                }}>
                  <span style={{fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{r.label}</span>
                  <span style={{fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif", fontWeight:500}}>{r.val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToursPage({ onSelect }) {
  const [showNewTour, setShowNewTour] = useState(false);
  const [activeTab, setActiveTab] = useState("Tümü");
  const [search, setSearch]       = useState("");
  const { data:repoTours, loading:toursLoading, error:toursError, reload:reloadTours }
    = useRepo("tour", "getAll");

  const TABS = ["Tümü","Aktif","Taslak","Arşiv"];
  // Supabase mode: never show the mock catalog while the real list is loading/empty.
  const allTours = repoTours ?? (AppConfig.useSupabase ? [] : MOCK_TOURS);
  const filtered = allTours.filter(t => {
    const tabOk  = activeTab==="Tümü" || t.status===activeTab;
    const srchOk = !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.category.toLowerCase().includes(search.toLowerCase());
    return tabOk && srchOk;
  });

  const counts = TABS.reduce((acc,t)=>({...acc, [t]: t==="Tümü"?allTours.length:allTours.filter(x=>x.status===t).length}),{});
  const activeRevenue = allTours.filter(t=>t.status==="Aktif").reduce((s,t)=>s+(t.usageCount||0),0);

  return (
    <>
    {showNewTour ? (<NewTourModal onClose={()=>{ setShowNewTour(false); reloadTours&&reloadTours(); }}/>) : null}
    <div style={{display:"flex", flexDirection:"column", gap:20}}>

      {}
      <div className="page-header" style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"20px 24px",
        display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:20,
      }}>
        <div>
          <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:5}}>Turlar</h1>
          <p style={{margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
            Teklif ve rezervasyonlarda kullanılacak tur seçeneklerini yönetin.
          </p>
        </div>
        <div className="page-header-actions" style={{display:"flex", alignItems:"center", gap:10, flexShrink:0}}>
          <div style={{position:"relative"}}>
            <span style={{position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.textFaint, pointerEvents:"none"}}>
              <URIc d="M21 21l-4.35-4.35 M17 11A6 6 0 105 11a6 6 0 0012 0z" size={14} sw={1.8}/>
            </span>
            <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Tur adı veya kategori ara…"
              style={{
                paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
                border:`1px solid ${C.border}`, borderRadius:8,
                background:C.ivory, fontSize:13, color:C.text,
                fontFamily:"'DM Sans',sans-serif", outline:"none", width:"min(220px,45vw)",
                transition:"border-color .15s, box-shadow .15s",
              }}
              onFocus={e=>{ e.target.style.borderColor=C.gold; e.target.style.boxShadow=`0 0 0 3px ${C.gold}20`; }}
              onBlur={e=>{ e.target.style.borderColor=C.border; e.target.style.boxShadow="none"; }}
            />
          </div>
          <button style={{
            display:"flex", alignItems:"center", gap:7,
            padding:"9px 16px", borderRadius:8,
            border:"none", background:C.navy, cursor:"pointer", color:C.white,
            fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.navyHover}
            onMouseLeave={e=>e.currentTarget.style.background=C.navy}
          onClick={()=>setShowNewTour(true)}
          >
            <URIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
            Yeni Tur Ekle
          </button>
        </div>
      </div>

      {}
      <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14}}>
        {[
          { label:"Toplam Tur",      val:allTours.length,                              icon:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10", color:C.text,  bg:C.ivoryDark },
          { label:"Aktif Tur",       val:allTours.filter(t=>t.status==="Aktif").length,icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", color:C.green, bg:C.greenBg },
          { label:"Taslak",          val:allTours.filter(t=>t.status==="Taslak").length,icon:"M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z", color:C.amber, bg:C.amberBg },
          { label:"Toplam Kullanım", val:`${activeRevenue} kez`,                         icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", color:C.blue,  bg:C.blueBg },
        ].map((k,i)=>(
          <div key={i} style={{
            background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
            padding:"18px 20px", display:"flex", alignItems:"center", gap:14,
          }}>
            <div style={{width:40, height:40, borderRadius:10, flexShrink:0, background:k.bg, display:"flex", alignItems:"center", justifyContent:"center"}}>
              <URIc d={k.icon} size={18} sw={1.6} color={k.color}/>
            </div>
            <div>
              <div style={{fontSize:24, fontWeight:700, color:k.color, fontFamily:"'Playfair Display',serif", lineHeight:1, marginBottom:3}}>{k.val}</div>
              <div style={{fontSize:12, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {}
      <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>

        {}
        <div style={{display:"flex", alignItems:"center", borderBottom:`1px solid ${C.borderLight}`, padding:"0 20px", overflowX:"auto"}}>
          {TABS.map(tab=>{
            const on=activeTab===tab;
            return (
              <button key={tab} onClick={()=>setActiveTab(tab)} style={{
                padding:"13px 14px",
                border:"none", borderBottom: on?`2px solid ${C.gold}`:"2px solid transparent",
                background:"transparent",
                color: on?C.gold:C.textMuted,
                fontFamily:"'DM Sans',sans-serif", fontSize:13,
                fontWeight:on?600:400, cursor:"pointer",
                whiteSpace:"nowrap", marginBottom:-1,
                display:"flex", alignItems:"center", gap:6, transition:"color .12s",
              }}>
                {tab}
                {counts[tab]>0 && (
                  <span style={{
                    minWidth:18, height:18, borderRadius:99, padding:"0 5px",
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:10.5, fontWeight:600,
                    background:on?`${C.gold}22`:C.ivoryDark, color:on?C.gold:C.textFaint,
                  }}>{counts[tab]}</span>
                )}
              </button>
            );
          })}
          <div style={{marginLeft:"auto", padding:"0 4px", flexShrink:0}}>
            <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{filtered.length} tur</span>
          </div>
        </div>

        {}
        {filtered.length===0 ? (
          <div style={{padding:"60px 40px", textAlign:"center"}}>
            <div style={{fontSize:36, opacity:.2, marginBottom:12}}>🗺</div>
            <div style={{fontSize:15, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6}}>Tur bulunamadı.</div>
          </div>
        ) : (
          <>
            <table className="rsp-table" style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${C.border}`, background:C.ivory}}>
                  {["Tur Adı","Kategori","Süre","Fiyatlandırma","Başlangıç Fiyatı","Kullanım","Durum","Son Güncelleme",""].map((h,i)=>(
                    <th key={i} style={{
                      padding: i===0?"11px 16px 11px 22px":"11px 12px",
                      textAlign:"left", fontSize:10.5, fontWeight:600,
                      color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
                      textTransform:"uppercase", letterSpacing:"0.07em", whiteSpace:"nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((tour,i)=>{
                  const isLast=i===filtered.length-1;
                  const sym=tour.currency==="TRY"?"₺":"€";
                  return (
                    <tr key={tour.id}
                      onMouseEnter={()=>setHov(true)}
                      onMouseLeave={()=>setHov(false)}
                      onClick={()=>onSelect&&onSelect(tour.id)}
                      style={{
                        background:C.white, cursor:"pointer", transition:"background .1s",
                        opacity:tour.status==="Arşiv"?0.65:1,
                      }}>
                      {}
                      <td style={{padding:"14px 16px 14px 22px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <div style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{tour.name}</div>
                        <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Mono',monospace", marginTop:2}}>{tour.id}</div>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <TourCatPill category={tour.category}/>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <div style={{display:"flex", alignItems:"center", gap:6, color:C.textMid}}>
                          <URIc d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" size={13} sw={1.5} color={C.textFaint}/>
                          <span style={{fontSize:13, fontFamily:"'DM Sans',sans-serif"}}>{tour.duration}</span>
                        </div>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <span style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{tour.pricingType}</span>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <div style={{fontSize:15, fontWeight:700, color:C.gold, fontFamily:"'Playfair Display',serif"}}>
                          {sym}{tour.basePrice}
                          {tour.pricingType==="Kişi Bazlı" && <span style={{fontSize:11, fontWeight:400, color:C.textFaint}}>/kişi</span>}
                        </div>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <span style={{fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{tour.usageCount}×</span>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <TourStatusBadge status={tour.status}/>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <span style={{fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{tour.updatedAt}</span>
                      </td>
                      {}
                      <td style={{padding:"14px 16px 14px 8px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <URIc d="M9 18l6-6-6-6" size={14} sw={1.8} color={C.textFaint}/>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="rsp-cards"><MobileCardList items={filtered} renderCard={(tour) => {
              const tscm = TOUR_STATUS_CFG[tour.status]||{color:C.textMuted,bg:C.ivoryDark,dot:C.textFaint};
              const sym = tour.currency==="TRY"?"₺":"€";
              return (
                <MobileCard onClick={()=>onSelect&&onSelect(tour.id)}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <div style={{fontSize:14,fontWeight:600,color:C.text,fontFamily:"'DM Sans',sans-serif"}}>{tour.name}</div>
                    <span style={{fontSize:11,padding:"2px 7px",borderRadius:99,color:tscm.color,background:tscm.bg,fontFamily:"'DM Sans',sans-serif",fontWeight:500,flexShrink:0}}>{tour.status}</span>
                  </div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    <span style={{fontSize:12,color:C.textMuted,fontFamily:"'DM Sans',sans-serif"}}>{tour.category} · {tour.duration}</span>
                    <span style={{fontSize:13,fontWeight:700,color:C.gold,fontFamily:"'Playfair Display',serif"}}>{sym}{tour.basePrice}{tour.pricingType==="Kişi Bazlı"?"/kişi":""}</span>
                  </div>
                </MobileCard>
              );
            }}/></div>
            <div style={{padding:"11px 20px", background:C.ivory, borderTop:`1px solid ${C.borderLight}`}}>
              <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{filtered.length} / {DB.tours.length} tur · Satıra tıklayarak düzenleyin</span>
            </div>
          </>
        )}
      </div>
    </div>
    </>
  );
}

function SIc({ d, size=15, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function SToggle({ on, onChange }) {
  return (
    <div onClick={()=>onChange(!on)} style={{
      width:44, height:24, borderRadius:99, cursor:"pointer",
      background:on?C.navy:C.borderLight, transition:"background .2s",
      position:"relative", flexShrink:0,
    }}>
      <div style={{
        width:18, height:18, borderRadius:"50%", background:C.white,
        position:"absolute", top:3, left:on?23:3,
        transition:"left .2s", boxShadow:"0 1px 4px rgba(0,0,0,0.2)",
      }}/>
    </div>
  );
}

function SField({ label, hint, children }) {
  return (
    <div style={{padding:"14px 0", borderBottom:`1px solid ${C.borderLight}`, display:"flex", alignItems:"flex-start", gap:24}}>
      <div style={{minWidth:200, flexShrink:0, paddingTop:1}}>
        <div style={{fontSize:13.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif", marginBottom:2}}>{label}</div>
        {hint && <div style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", lineHeight:1.4}}>{hint}</div>}
      </div>
      <div style={{flex:1}}>{children}</div>
    </div>
  );
}

function SInput({ value, onChange, placeholder, type="text" }) {
  const [foc, setFoc] = useState(false);
  return (
    <input type={type} value={value} onChange={e=>onChange(e.target.value)}
      placeholder={placeholder}
      onFocus={()=>setFoc(true)} onBlur={()=>setFoc(false)}
      style={{
        width:"100%", padding:"9px 12px", boxSizing:"border-box",
        border:`1px solid ${foc?C.gold:C.border}`, borderRadius:7,
        background:C.ivory, fontSize:13, color:C.text,
        fontFamily:"'DM Sans',sans-serif", outline:"none",
        boxShadow:foc?`0 0 0 3px ${C.gold}18`:"none",
        transition:"border-color .15s, box-shadow .15s",
      }}/>
  );
}

function SSelect({ value, onChange, options }) {
  return (
    <select value={value} onChange={e=>onChange(e.target.value)} style={{
      padding:"9px 12px", border:`1px solid ${C.border}`, borderRadius:7,
      background:C.ivory, fontSize:13, color:C.text,
      fontFamily:"'DM Sans',sans-serif", outline:"none", cursor:"pointer",
    }}>
      {options.map(o=><option key={o}>{o}</option>)}
    </select>
  );
}

function SSection({ id, title, icon, children }) {
  return (
    <div id={id} style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
      <div style={{
        padding:"16px 24px",
        background:C.ivory, borderBottom:`1px solid ${C.border}`,
        display:"flex", alignItems:"center", gap:10,
      }}>
        <div style={{
          width:32, height:32, borderRadius:8,
          background:C.navy, display:"flex", alignItems:"center", justifyContent:"center",
        }}>
          <SIc d={icon} size={15} sw={1.8} color={C.goldLight}/>
        </div>
        <span style={{fontSize:15, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>{title}</span>
      </div>
      <div style={{padding:"4px 24px 16px"}}>{children}</div>
    </div>
  );
}

function SaveBtn({ saved, onClick }) {
  return (
    <button onClick={onClick} style={{
      display:"flex", alignItems:"center", gap:7,
      padding:"8px 18px", borderRadius:7,
      border:"none", background:saved?C.green:C.navy,
      cursor:"pointer", color:C.white,
      fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:600,
      transition:"background .2s",
    }}>
      <SIc d={saved?"M20 6L9 17l-5-5":"M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v14a2 2 0 01-2 2z M17 21v-8H7v8 M7 3v5h8"} size={14} sw={2} color="#fff"/>
      {saved?"Kaydedildi ✓":"Kaydet"}
    </button>
  );
}

function SettingsPage() {
  const [hov, setHov] = useState(false);
  const [activeSection, setActiveSection] = useState("sirket");

  const { data:staffData, loading:staffLoading } = useRepo("staff", "getAll");
  const users = staffData ?? [];

  const [companyName, setCompanyName] = useState("Dese Tour");
  const [website, setWebsite]         = useState("www.desetour.com");
  const [email, setEmail]             = useState("hello@desetour.com");
  const [phone, setPhone]             = useState("+90 555 123 45 67");
  const [address, setAddress]         = useState("İstanbul, Türkiye");
  const [currency, setCurrency]       = useState("EUR");
  const [saved1, setSaved1]           = useState(false);

  const [pdfTemplate, setPdfTemplate] = useState("Premium");
  const [saved2, setSaved2]           = useState(false);

  const [sources, setSources] = useState([
    { id:1, label:"Website",     active:true  },
    { id:2, label:"WhatsApp",    active:true  },
    { id:3, label:"Telefon",     active:true  },
    { id:4, label:"Instagram",   active:true  },
    { id:5, label:"Facebook",    active:true  },
    { id:6, label:"Booking",     active:true  },
    { id:7, label:"Tripadvisor", active:false },
    { id:8, label:"Email",       active:true  },
    { id:9, label:"Manuel",      active:true  },
    { id:10, label:"Civitatis",  active:true  },
  ]);
  const [newSource, setNewSource] = useState("");

  const [notifs, setNotifs] = useState({
    whatsapp:false, email:false, sms:false,
  });

  const [automations, setAutomations] = useState([
    { id:1, label:"Turdan 24 saat önce müşteriye hatırlatma gönder", active:false, trigger:"Tur − 24s", action:"WhatsApp / SMS" },
    { id:2, label:"Turdan 3 saat önce rehbere misafir bilgisi ilet", active:false, trigger:"Tur − 3s",  action:"SMS / Uygulama" },
    { id:3, label:"48 saat ödeme beklerse otomatik takip görevi oluştur", active:false, trigger:"Ödeme + 48s", action:"Sistem görevi" },
    { id:4, label:"Tur tamamlandıktan 24 saat sonra yorum isteği gönder", active:false, trigger:"Tur + 24s", action:"E-posta" },
  ]);

  function useSaved(setter) {
    return () => { setter(true); setTimeout(()=>setter(false), 2200); };
  }

  const ROLES = ["Yönetici","Satış","Operasyon","Rehber"];

  const NAV_SECTIONS = [
    { id:"sirket",    label:"Şirket Bilgileri",    icon:"M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" },
    { id:"marka",     label:"Marka Ayarları",      icon:"M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" },
    { id:"kullanicilar",label:"Kullanıcılar",      icon:"M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" },
    { id:"kaynaklar", label:"Lead Kaynakları",     icon:"M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" },
    { id:"durumlar",  label:"Durum Ayarları",      icon:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" },
    { id:"bildirimler",label:"Bildirim Ayarları",  icon:"M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" },
    { id:"otomasyon", label:"Otomasyon Kuralları", icon:"M13 10V3L4 14h7v7l9-11h-7z" },
  ];

  return (
    <div style={{display:"flex", flexDirection:"column", gap:0}}>

      {}
      <div style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"20px 24px", marginBottom:20,
        display:"flex", alignItems:"center", justifyContent:"space-between",
      }}>
        <div>
          <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:4}}>Ayarlar</h1>
          <p style={{margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
            Dese Tour Operations Center sistem ayarlarını yönetin.
          </p>
        </div>
        <div style={{
          display:"flex", alignItems:"center", gap:8,
          fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
        }}>
          <SIc d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" size={16} sw={1.8} color={C.green}/>
          Değişiklikler güvenli şekilde kaydedilir
        </div>
      </div>

      {}
      <div className="rsp-split" style={{display:"grid", gridTemplateColumns:"220px 1fr", gap:20, alignItems:"start"}}>

        {}
        <div style={{
          background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
          padding:"10px 10px", position:"sticky", top:20,
        }}>
          {NAV_SECTIONS.map(s=>{
            const on = activeSection===s.id;
            return (
              <button key={s.id}
                onClick={()=>setActiveSection(s.id)}
                onMouseEnter={()=>setHov(true)}
                onMouseLeave={()=>setHov(false)}
                style={{
                  display:"flex", alignItems:"center", gap:10, width:"100%",
                  padding:"10px 12px", border:"none", borderRadius:8,
                  background: on?"rgba(27,45,79,0.07)":hov?"rgba(27,45,79,0.03)":"transparent",
                  color: on?C.navy:hov?C.textMid:C.textMuted,
                  cursor:"pointer", textAlign:"left", marginBottom:2,
                  transition:"background .1s, color .1s",
                  borderLeft: on?`3px solid ${C.gold}`:"3px solid transparent",
                }}>
                <SIc d={s.icon} size={15} sw={on?2:1.5} color={on?C.navy:C.textFaint}/>
                <span style={{
                  fontSize:13, fontWeight:on?600:400,
                  fontFamily:"'DM Sans',sans-serif",
                }}>{s.label}</span>
              </button>
            );
          })}
        </div>

        {}
        <div style={{display:"flex", flexDirection:"column", gap:20}}>

          {}
          {activeSection==="sirket" && (
            <SSection id="sirket" title="Şirket Bilgileri" icon="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4">
              <SField label="Şirket Adı" hint="Tekliflerde ve belgelerde görünür">
                <SInput value={companyName} onChange={setCompanyName} placeholder="Şirket adı"/>
              </SField>
              <SField label="Website" hint="www.desert...">
                <SInput value={website} onChange={setWebsite} placeholder="www.desetour.com"/>
              </SField>
              <SField label="E-posta" hint="Gönderilen e-postalarda göründen adres">
                <SInput value={email} onChange={setEmail} placeholder="hello@desetour.com" type="email"/>
              </SField>
              <SField label="Telefon">
                <SInput value={phone} onChange={setPhone} placeholder="+90 555 000 0000"/>
              </SField>
              <SField label="Adres" hint="Teklif ve fatura altbilgisinde kullanılır">
                <SInput value={address} onChange={setAddress} placeholder="İstanbul, Türkiye"/>
              </SField>
              <SField label="Varsayılan Para Birimi" hint="Yeni teklif ve rezervasyonlarda kullanılır">
                <SSelect value={currency} onChange={setCurrency} options={["EUR","USD","TRY","GBP"]}/>
              </SField>
              {!AppConfig.useSupabase && (
                <div style={{padding:"8px 12px", borderRadius:7, background:"rgba(201,168,76,0.08)",
                  border:"1px solid rgba(201,168,76,0.2)", marginBottom:10,
                  fontSize:12, color:"#854F0B", fontFamily:"'DM Sans',sans-serif"}}>
                  Bu ayarlar canlı veritabanına sonraki sürümde kaydedilecek.
                </div>
              )}
              <div style={{paddingTop:16, display:"flex", justifyContent:"flex-end"}}>
                <SaveBtn saved={saved1} onClick={useSaved(setSaved1)}/>
              </div>
            </SSection>
          )}

          {}
          {activeSection==="marka" && (
            <SSection id="marka" title="Marka Ayarları" icon="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01">
              {}
              <SField label="Şirket Logosu" hint="Teklifler ve PDF'lerde kullanılır">
                <div style={{
                  width:"100%", maxWidth:320, height:100, borderRadius:10,
                  border:`2px dashed ${C.border}`, background:C.ivory,
                  display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8,
                  cursor:"pointer",
                }}
                  onMouseEnter={e=>{ e.currentTarget.style.borderColor=C.gold; e.currentTarget.style.background=C.goldPale; }}
                  onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.background=C.ivory; }}
                >
                  <SIc d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" size={24} sw={1.4} color={C.textFaint}/>
                  <span style={{fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>Logo yüklemek için tıklayın</span>
                  <span style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>PNG, JPG — max 2MB (yakında aktif)</span>
                </div>
              </SField>

              {}
              <SField label="Marka Renkleri" hint="Teklif önizlemesi ve PDF şablonunda kullanılır">
                <div style={{display:"flex", flexDirection:"column", gap:10}}>
                  {[
                    { name:"Ana Renk",    desc:"Derin Lacivert", hex:"#1B2D4F", sample:C.navy },
                    { name:"Vurgu Rengi", desc:"Yumuşak Altın",  hex:"#C9A84C", sample:C.goldLight },
                    { name:"Arka Plan",   desc:"Sıcak Fildişi",  hex:"#FAF7F0", sample:C.ivory, border:true },
                  ].map((col,i)=>(
                    <div key={i} style={{display:"flex", alignItems:"center", gap:14}}>
                      <div style={{
                        width:40, height:40, borderRadius:8,
                        background:col.sample,
                        border: col.border?`1px solid ${C.border}`:"none",
                        flexShrink:0,
                      }}/>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{col.name}</div>
                        <div style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{col.desc}</div>
                      </div>
                      <span style={{
                        fontSize:12, fontFamily:"'DM Mono',monospace", color:C.textMuted,
                        background:C.ivory, border:`1px solid ${C.borderLight}`,
                        padding:"3px 8px", borderRadius:5,
                      }}>{col.hex}</span>
                      <span style={{
                        fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
                        fontStyle:"italic",
                      }}>Kilitli</span>
                    </div>
                  ))}
                </div>
              </SField>

              {}
              <SField label="Teklif PDF Şablonu" hint="Müşterilere gönderilecek teklif formatı">
                <div style={{display:"flex", gap:12}}>
                  {["Premium","Minimal","Klasik"].map(t=>{
                    const on = pdfTemplate===t;
                    return (
                      <button key={t} onClick={()=>setPdfTemplate(t)} style={{
                        padding:"12px 20px", borderRadius:9, cursor:"pointer",
                        border: on?`1.5px solid ${C.gold}`:`1px solid ${C.border}`,
                        background: on?C.goldPale:C.white, color: on?C.gold:C.textMid,
                        fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:on?600:400,
                        transition:"all .12s",
                      }}>{t}</button>
                    );
                  })}
                </div>
              </SField>

              <div style={{paddingTop:16, display:"flex", justifyContent:"flex-end"}}>
                <SaveBtn saved={saved2} onClick={useSaved(setSaved2)}/>
              </div>
            </SSection>
          )}

          {}
          {activeSection==="kullanicilar" && (
            <SSection id="kullanicilar" title="Kullanıcılar" icon="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z">
              {}
              <div style={{marginTop:8}}>
                {users.map((u,i)=>(
                  <div key={u.id} style={{
                    display:"flex", alignItems:"center", gap:14,
                    padding:"14px 0",
                    borderBottom: i<users.length-1?`1px solid ${C.borderLight}`:"none",
                  }}>
                    <div style={{
                      width:40, height:40, borderRadius:"50%", flexShrink:0,
                      background: u.active?"rgba(27,45,79,0.09)":"rgba(0,0,0,0.05)",
                      border:`1.5px solid ${u.active?"rgba(27,45,79,0.15)":C.border}`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                    }}>
                      <span style={{fontSize:13, fontWeight:700, color:u.active?C.navy:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{u.initials}</span>
                    </div>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontSize:14, fontWeight:500, color:u.active?C.text:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{u.name}</div>
                      <div style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{u.email}</div>
                    </div>
                    <select value={u.role}
                      onChange={e=>setUsers(prev=>prev.map((x,j)=>j===i?{...x,role:e.target.value}:x))}
                      style={{
                        padding:"6px 10px", border:`1px solid ${C.border}`, borderRadius:6,
                        background:C.ivory, fontSize:12.5, color:C.text,
                        fontFamily:"'DM Sans',sans-serif", outline:"none", cursor:"pointer",
                      }}>
                      {ROLES.map(r=><option key={r}>{r}</option>)}
                    </select>
                    <div style={{display:"flex", alignItems:"center", gap:8}}>
                      <span style={{fontSize:12, color:u.active?C.green:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{u.active?"Aktif":"Pasif"}</span>
                      <SToggle on={u.active} onChange={v=>setUsers(prev=>prev.map((x,j)=>j===i?{...x,active:v}:x))}/>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{paddingTop:14}}>
                <button style={{
                  display:"flex", alignItems:"center", gap:7,
                  padding:"9px 16px", borderRadius:7,
                  border:`1.5px dashed ${C.border}`, background:C.white,
                  cursor:"pointer", color:C.textMuted,
                  fontFamily:"'DM Sans',sans-serif", fontSize:13,
                  transition:"border-color .1s, color .1s",
                }}
                  onMouseEnter={e=>{ e.currentTarget.style.borderColor=C.navy; e.currentTarget.style.color=C.navy; }}
                  onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.color=C.textMuted; }}
                >
                  <SIc d="M12 5v14M5 12h14" size={13} sw={2}/>
                  Yeni Kullanıcı Davet Et (Yakında)
                </button>
              </div>
            </SSection>
          )}

          {}
          {activeSection==="kaynaklar" && (
            <SSection id="kaynaklar" title="Lead Kaynakları" icon="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z">
              <div style={{marginTop:8}}>
                {sources.map((s,i)=>(
                  <div key={s.id} style={{
                    display:"flex", alignItems:"center", gap:12,
                    padding:"11px 0",
                    borderBottom: i<sources.length-1?`1px solid ${C.borderLight}`:"none",
                  }}>
                    <div style={{
                      width:8, height:8, borderRadius:"50%",
                      background:s.active?C.green:C.border, flexShrink:0,
                    }}/>
                    <span style={{
                      flex:1, fontSize:13.5, fontFamily:"'DM Sans',sans-serif",
                      color:s.active?C.text:C.textFaint,
                      fontWeight:s.active?500:400,
                    }}>{s.label}</span>
                    <span style={{
                      fontSize:11, color:s.active?C.green:C.textFaint,
                      fontFamily:"'DM Sans',sans-serif",
                    }}>{s.active?"Aktif":"Pasif"}</span>
                    <SToggle on={s.active} onChange={v=>setSources(prev=>prev.map((x,j)=>j===i?{...x,active:v}:x))}/>
                    <button onClick={()=>setSources(prev=>prev.filter((_,j)=>j!==i))} style={{
                      background:"none", border:"none", cursor:"pointer", color:C.textFaint, padding:4,
                    }}>
                      <SIc d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" size={14} sw={1.6}/>
                    </button>
                  </div>
                ))}
              </div>
              <div style={{display:"flex", gap:8, marginTop:14}}>
                <input value={newSource} onChange={e=>setNewSource(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter"&&newSource.trim()){ setSources(p=>[...p,{id:Date.now(),label:newSource.trim(),active:true}]); setNewSource(""); } }}
                  placeholder="Yeni kaynak ekle…"
                  style={{
                    flex:1, padding:"8px 12px", border:`1px solid ${C.border}`, borderRadius:7,
                    background:C.ivory, fontSize:13, color:C.text,
                    fontFamily:"'DM Sans',sans-serif", outline:"none",
                  }}/>
                <button onClick={()=>{ if(newSource.trim()){ setSources(p=>[...p,{id:Date.now(),label:newSource.trim(),active:true}]); setNewSource(""); } }} style={{
                  padding:"8px 16px", borderRadius:7, cursor:"pointer",
                  background:C.navy, border:"none", color:C.white,
                  fontSize:13, fontFamily:"'DM Sans',sans-serif", fontWeight:500,
                }}>+ Ekle</button>
              </div>
            </SSection>
          )}

          {}
          {activeSection==="durumlar" && (
            <SSection id="durumlar" title="Durum Ayarları" icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4">
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:20, marginTop:8}}>
                {[
                  {
                    title:"Talep Durumları",
                    icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
                    items:[
                      {label:"Yeni Talep",          color:"#1A6FAE", bg:"#E8F2FB"},
                      {label:"Görüşüldü",            color:"#B45309", bg:"#FEF3E2"},
                      {label:"Teklif Hazırlanıyor",  color:"#6B3FA0", bg:"#F3EEF9"},
                      {label:"Teklif Gönderildi",    color:"#B8973A", bg:"#F5EDD4"},
                      {label:"Ödeme Bekleniyor",     color:"#C05621", bg:"#FEF0E8"},
                      {label:"Onaylandı",            color:"#2E7D52", bg:"#EBF5EF"},
                      {label:"İptal",                color:"#C0392B", bg:"#FDECEC"},
                    ],
                  },
                  {
                    title:"Rezervasyon Durumları",
                    icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11",
                    items:[
                      {label:"Hazırlanıyor",  color:"#6B3FA0", bg:"#F3EEF9"},
                      {label:"Rehber Atandı", color:"#1A6FAE", bg:"#E8F2FB"},
                      {label:"Hazır",         color:"#B8973A", bg:"#F5EDD4"},
                      {label:"Tamamlandı",    color:"#2E7D52", bg:"#EBF5EF"},
                      {label:"İptal",         color:"#C0392B", bg:"#FDECEC"},
                    ],
                  },
                  {
                    title:"Ödeme Durumları",
                    icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20",
                    items:[
                      {label:"Bekliyor",       color:"#C05621", bg:"#FEF0E8"},
                      {label:"Kısmi Ödendi",   color:"#B8973A", bg:"#F5EDD4"},
                      {label:"Tamamlandı",     color:"#2E7D52", bg:"#EBF5EF"},
                      {label:"İade Edildi",    color:"#6B3FA0", bg:"#F3EEF9"},
                    ],
                  },
                ].map((grp,gi)=>(
                  <div key={gi}>
                    <div style={{
                      display:"flex", alignItems:"center", gap:7, marginBottom:12,
                      fontSize:12, fontWeight:600, color:C.textFaint,
                      textTransform:"uppercase", letterSpacing:"0.08em",
                      fontFamily:"'DM Sans',sans-serif",
                    }}>
                      <SIc d={grp.icon} size={13} sw={1.6} color={C.textFaint}/>
                      {grp.title}
                    </div>
                    {grp.items.map((item,ii)=>(
                      <div key={ii} style={{
                        display:"flex", alignItems:"center", gap:8,
                        padding:"8px 10px", borderRadius:7, marginBottom:5,
                        background:item.bg,
                      }}>
                        <span style={{width:7, height:7, borderRadius:"50%", background:item.color, flexShrink:0}}/>
                        <span style={{fontSize:12.5, color:item.color, fontFamily:"'DM Sans',sans-serif", fontWeight:500}}>{item.label}</span>
                      </div>
                    ))}
                    <div style={{
                      marginTop:10, fontSize:11.5, color:C.textFaint,
                      fontFamily:"'DM Sans',sans-serif', lineHeight:1.4",
                      fontStyle:"italic",
                    }}>Durum renkleri sistem genelinde sabit.</div>
                  </div>
                ))}
              </div>
            </SSection>
          )}

          {}
          {activeSection==="bildirimler" && (
            <SSection id="bildirimler" title="Bildirim Ayarları" icon="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9">
              {[
                {
                  id:"whatsapp", label:"WhatsApp Business",
                  desc:"Müşteri ve rehberlere otomatik WhatsApp mesajı gönderimi",
                  icon:"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z",
                  color:"#128C7E", bg:"#E7F5F3",
                },
                {
                  id:"email", label:"E-posta Entegrasyonu",
                  desc:"Teklif, ödeme hatırlatma ve tur bilgisi e-postaları (Resend)",
                  icon:"M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6",
                  color:"#1A6FAE", bg:"#E8F2FB",
                },
                {
                  id:"sms", label:"SMS Bildirimleri",
                  desc:"Acil operasyon uyarıları için SMS gönderimi",
                  icon:"M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
                  color:"#6B3FA0", bg:"#F3EEF9",
                },
              ].map(ch=>(
                <div key={ch.id} style={{
                  padding:"16px 0", borderBottom:`1px solid ${C.borderLight}`,
                  display:"flex", alignItems:"flex-start", gap:16,
                }}>
                  <div style={{
                    width:40, height:40, borderRadius:10, flexShrink:0,
                    background:ch.bg, display:"flex", alignItems:"center", justifyContent:"center",
                    color:ch.color,
                  }}>
                    <SIc d={ch.icon} size={18} sw={1.6} color={ch.color}/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:3}}>
                      <span style={{fontSize:14, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{ch.label}</span>
                      <span style={{
                        fontSize:10.5, fontWeight:600, color:"#6B7280",
                        background:"#F3F4F6", padding:"1px 7px", borderRadius:99,
                        fontFamily:"'DM Sans',sans-serif", letterSpacing:"0.04em",
                      }}>YAKINDA</span>
                    </div>
                    <div style={{fontSize:13, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", lineHeight:1.5}}>{ch.desc}</div>
                  </div>
                  <SToggle on={notifs[ch.id]} onChange={v=>setNotifs(p=>({...p,[ch.id]:v}))}/>
                </div>
              ))}
              <div style={{
                marginTop:16, padding:"14px 16px", borderRadius:10,
                background:C.goldPale, border:`1px solid ${C.gold}30`,
                display:"flex", gap:10, alignItems:"flex-start",
              }}>
                <SIc d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" size={18} sw={1.7} color={C.gold}/>
                <div style={{fontSize:13, color:C.amber, fontFamily:"'DM Sans',sans-serif", lineHeight:1.6}}>
                  Bildirim entegrasyonları V2 geliştirmesinde aktif edilecek. WhatsApp Business API ve Resend entegrasyonu hazırlık aşamasında.
                </div>
              </div>
            </SSection>
          )}

          {}
          {activeSection==="otomasyon" && (
            <SSection id="otomasyon" title="Otomasyon Kuralları" icon="M13 10V3L4 14h7v7l9-11h-7z">
              <div style={{
                padding:"12px 14px", borderRadius:9, marginTop:8, marginBottom:16,
                background:C.goldPale, border:`1px solid ${C.gold}30`,
                display:"flex", gap:10, alignItems:"flex-start",
              }}>
                <SIc d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" size={16} sw={1.7} color={C.gold}/>
                <div style={{fontSize:13, color:C.amber, fontFamily:"'DM Sans',sans-serif", lineHeight:1.5}}>
                  Otomasyon kuralları V2'de aktif olacak. Şu an önizleme ve yapılandırma modundadır.
                </div>
              </div>

              {automations.map((a,i)=>(
                <div key={a.id} style={{
                  padding:"16px 0",
                  borderBottom: i<automations.length-1?`1px solid ${C.borderLight}`:"none",
                  display:"flex", alignItems:"flex-start", gap:16,
                }}>
                  <div style={{
                    width:38, height:38, borderRadius:9, flexShrink:0,
                    background: a.active?"rgba(27,45,79,0.08)":C.ivoryDark,
                    border:`1px solid ${a.active?C.navy+"33":C.borderLight}`,
                    display:"flex", alignItems:"center", justifyContent:"center",
                  }}>
                    <SIc d="M13 10V3L4 14h7v7l9-11h-7z" size={16} sw={1.7} color={a.active?C.navy:C.textFaint}/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13.5, fontWeight:500, color:a.active?C.text:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginBottom:6}}>
                      {a.label}
                    </div>
                    <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
                      <span style={{
                        fontSize:11.5, padding:"2px 8px", borderRadius:5,
                        background:C.ivoryDark, color:C.textMuted,
                        fontFamily:"'DM Sans',sans-serif",
                      }}>⚡ {a.trigger}</span>
                      <span style={{
                        fontSize:11.5, padding:"2px 8px", borderRadius:5,
                        background:C.blueBg, color:C.blue,
                        fontFamily:"'DM Sans',sans-serif",
                      }}>→ {a.action}</span>
                    </div>
                  </div>
                  <SToggle on={a.active} onChange={v=>setAutomations(prev=>prev.map((x,j)=>j===i?{...x,active:v}:x))}/>
                </div>
              ))}
            </SSection>
          )}

        </div>
      </div>
    </div>
  );
}

const _COUNTRY_FLAG = {
  "Avustralya":"🇦🇺","İngiltere":"🇬🇧","ABD":"🇺🇸","Almanya":"🇩🇪","Japonya":"🇯🇵",
  "İtalya":"🇮🇹","Fransa":"🇫🇷","Türkiye":"🇹🇷","Hollanda":"🇳🇱","İspanya":"🇪🇸",
  "Kanada":"🇨🇦","Brezilya":"🇧🇷","Diğer":"🌍",
};

function calculateReportMetrics(period, leads, quotes, reservations, payments, customers) {
  const _leads   = leads        ?? [];
  const _quotes  = quotes       ?? [];
  const _res     = reservations ?? [];
  const _pays    = payments     ?? [];
  const _custs   = customers    ?? [];

  const fLeads = filterByDateRange(_leads,   "createdAt",  period);
  const fQuotes= filterByDateRange(_quotes,  "createdAt",  period);
  const fRes   = filterByDateRange(_res,     "checkIn",    period);
  const fPays  = filterByDateRange(_pays,    "createdAt",  period);

  const kpi = {
    leads:        fLeads.length,
    quotes:       fQuotes.length,
    reservations: fRes.length,
    completed:    fRes.filter(r=>r.opStatus==="Tamamlandı").length,
    expectedEur:  fPays.filter(p=>p.currency==="EUR")
                   .reduce((s,p)=>{ const r=getReservationById(p.resId||""); return s+(r?r.total:p.amount); },0),
    collectedEur: fPays.filter(p=>p.currency==="EUR"&&!["Bekliyor"].includes(p.status))
                   .reduce((s,p)=>s+parseFloat(p.amount||0), 0),
  };

  const sourceMap = {};
  fLeads.forEach(l => {
    const src = l.sourceId
      ? (DB.sources.find(s=>s.id===l.sourceId)?.label || "Diğer")
      : (l.importType === "manual" ? "Manuel" : "Diğer");
    if (!sourceMap[src]) sourceMap[src] = { source:src, leads:0, quotes:0, reservations:0, revenue:0 };
    sourceMap[src].leads++;
  });
  fQuotes.forEach(q => {
    const lead = _leads.find(l=>l.id===q.leadId);
    const src  = lead?.sourceId
      ? (DB.sources.find(s=>s.id===lead.sourceId)?.label || "Diğer")
      : "Diğer";
    if (!sourceMap[src]) sourceMap[src] = { source:src, leads:0, quotes:0, reservations:0, revenue:0 };
    sourceMap[src].quotes++;
  });
  fRes.forEach(r => {
    const lead = _leads.find(l=>l.id===r.leadId);
    const src  = lead?.sourceId
      ? (DB.sources.find(s=>s.id===lead.sourceId)?.label || "Diğer")
      : "Diğer";
    if (!sourceMap[src]) sourceMap[src] = { source:src, leads:0, quotes:0, reservations:0, revenue:0 };
    sourceMap[src].reservations++;
    sourceMap[src].revenue += parseFloat(r.total||0);
  });
  const sourcesData = Object.values(sourceMap)
    .map(s => ({ ...s, conversion: s.leads>0 ? Math.round(s.reservations/s.leads*100) : 0 }))
    .sort((a,b)=>b.leads-a.leads);

  const tourMap = {};
  fRes.forEach(r => {
    const name = r.tour || "Diğer";
    if (!tourMap[name]) tourMap[name] = { name, reservations:0, guests:0, revenue:0 };
    tourMap[name].reservations++;
    tourMap[name].guests += parseInt(r.pax||1);
    tourMap[name].revenue += parseFloat(r.total||0);
  });
  const toursData = Object.values(tourMap)
    .map(t => ({ ...t, avgPrice: t.reservations>0 ? Math.round(t.revenue/t.reservations) : 0 }))
    .sort((a,b)=>b.revenue-a.revenue)
    .slice(0,6);

  const countryMap = {};
  fLeads.forEach(l => {
    const cust = _custs.find(c=>c.id===l.customerId);
    const country = cust?.country || cust?.nationality || "Diğer";
    if (!countryMap[country]) countryMap[country] = { country, flag:_COUNTRY_FLAG[country]||"🌍", leads:0, reservations:0, totalQuote:0, count:0 };
    countryMap[country].leads++;
  });
  fRes.forEach(r => {
    const cust = _custs.find(c=>c.id===r.customerId);
    const country = cust?.country || cust?.nationality || "Diğer";
    if (!countryMap[country]) countryMap[country] = { country, flag:_COUNTRY_FLAG[country]||"🌍", leads:0, reservations:0, totalQuote:0, count:0 };
    countryMap[country].reservations++;
    countryMap[country].totalQuote += parseFloat(r.total||0);
    countryMap[country].count++;
  });
  const countriesData = Object.values(countryMap)
    .map(c => ({ ...c, avgQuote: c.count>0 ? Math.round(c.totalQuote/c.count) : 0 }))
    .sort((a,b)=>b.leads-a.leads)
    .slice(0,8);

  const totalExpected = fPays.filter(p=>p.currency==="EUR")
    .reduce((s,p)=>{ const r=getReservationById(p.resId||""); return s+(r?r.total:p.amount); },0);
  const collected  = fPays.filter(p=>p.currency==="EUR"&&!["Bekliyor"].includes(p.status))
    .reduce((s,p)=>s+parseFloat(p.amount||0), 0);
  const pending    = fPays.filter(p=>p.currency==="EUR"&&p.status==="Bekliyor")
    .reduce((s,p)=>s+parseFloat(p.amount||0), 0);
  const partial    = fPays.filter(p=>p.currency==="EUR"&&p.status==="Kısmi Ödendi")
    .reduce((s,p)=>s+parseFloat(p.amount||0), 0);
  const refunded   = fPays.filter(p=>p.status==="İade Edildi")
    .reduce((s,p)=>s+parseFloat(p.amount||0), 0);

  const highValuePays = (_res)
    .filter(r => r.remaining > 0 && !["Tamamlandı","İptal"].includes(r.opStatus))
    .sort((a,b)=>b.remaining-a.remaining)
    .slice(0,5)
    .map(r => {
      const cust = _custs.find(c=>c.id===r.customerId);
      return { guest:cust?.name||"—", flag:cust?.flag||"🌍", resId:r.id, remaining:r.remaining, dueDate:r.date||"—", urgent:r.remaining>1000 };
    });

  const paymentsData = {
    expected: totalExpected,
    collected,
    pending,
    partial,
    refunded,
    highValue: highValuePays,
  };

  const opsData = {
    upcoming:   _res.filter(r=>!["Tamamlandı","İptal"].includes(r.opStatus)).length,
    completed:  _res.filter(r=>r.opStatus==="Tamamlandı").length,
    cancelled:  _res.filter(r=>r.opStatus==="İptal").length,
    noGuide:    _res.filter(r=>!r.guide&&!["Tamamlandı","İptal"].includes(r.opStatus)).length,
    noPickup:   _res.filter(r=>!r.pickup&&!["Tamamlandı","İptal"].includes(r.opStatus)).length,
  };

  return {
    kpi,
    sources: sourcesData,
    tours:   toursData,
    countries: countriesData,
    payments: paymentsData,
    ops: opsData,
  };
}

function calculateDashboardMetrics(leads, reservations, payments, tasks, reminders) {
  // When Supabase is active, use empty arrays (not DB mock) if data not loaded yet
  // This prevents KPIs briefly showing mock values then disappearing
  const empty = [];
  const _leads = leads         ?? empty;
  const _res   = reservations  ?? empty;
  const _pays  = payments      ?? empty;
  const _tasks = tasks         ?? empty;
  const _rems  = reminders     ?? empty;

  const today  = _TODAY_STR;
  const todayISO = _TODAY_ISO;

  const todayTours    = _res.filter(r => r.date===today || r.checkIn===todayISO);
  const upcomingRes   = _res.filter(r => !["Tamamlandı","İptal"].includes(r.opStatus));
  const openLeads     = _leads.filter(l => !["Onaylandı","İptal"].includes(l.status));
  const pendingPays   = _pays.filter(p => ["Bekliyor","Kısmi Ödendi"].includes(p.status));
  const pendingEUR    = pendingPays.filter(p=>p.currency==="EUR")
    .reduce((s,p)=>s+parseFloat(p.amount||0), 0);
  const highPrioTasks = _tasks.filter(t=>t.status!=="Tamamlandı"&&["Yüksek","Acil"].includes(t.priority));

  const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}-01`;
  const monthPays  = filterByDateRange(_pays, "createdAt", "Bu Ay");
  const monthRevEUR = monthPays.filter(p=>p.currency==="EUR")
    .reduce((s,p)=>{ const r=getReservationById(p.resId||""); return s+(r?r.total:parseFloat(p.amount||0)); },0);

  const urgentItems = computeUrgent(_leads, _res, _pays, _tasks, _rems);
  const recentActivities = DB.activityLogs.slice(-6).reverse();

  return {
    todayTours,
    todayTourCount: todayTours.length,
    todayTourPax:   todayTours.reduce((s,r)=>s+parseInt(r.pax||1),0),
    openLeadsCount: openLeads.length,
    pendingPaysCount: pendingPays.length,
    pendingEUR,
    upcomingRes:    upcomingRes.slice(0,5),
    upcomingCount:  upcomingRes.length,
    monthRevEUR,
    highPrioTasks:  highPrioTasks.length,
    urgentItems,
    recentActivities,
  };
}

function RpIc({ d, size=15, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function MiniBar({ value, max, color, height=6 }) {
  const pct = max > 0 ? Math.min(Math.round(value/max*100), 100) : 0;
  return (
    <div style={{width:"100%", height, background:C.ivoryDark, borderRadius:99, overflow:"hidden"}}>
      <div style={{width:`${pct}%`, height:"100%", background:color||C.gold, borderRadius:99, transition:"width .4s"}}/>
    </div>
  );
}

function RpSection({ title, icon, children, action }) {
  return (
    <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
      <div style={{
        padding:"16px 22px", background:C.ivory, borderBottom:`1px solid ${C.borderLight}`,
        display:"flex", alignItems:"center", justifyContent:"space-between",
      }}>
        <div style={{display:"flex", alignItems:"center", gap:9}}>
          <div style={{width:30, height:30, borderRadius:7, background:C.navy, display:"flex", alignItems:"center", justifyContent:"center"}}>
            <RpIc d={icon} size={14} sw={1.8} color={C.goldLight}/>
          </div>
          <span style={{fontSize:15, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>{title}</span>
        </div>
        {action && (
          <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{action}</span>
        )}
      </div>
      <div style={{padding:"20px 22px"}}>{children}</div>
    </div>
  );
}

function RpKpiCard({ label, value, sub, icon, color, bg, highlight }) {
  return (
    <div style={{
      background:C.white, border:`1px solid ${highlight?color+"44":C.border}`,
      borderRadius:12, padding:"18px 20px",
      display:"flex", alignItems:"flex-start", gap:14,
      boxShadow: highlight?`0 0 0 1px ${color}22`:"none",
    }}>
      <div style={{width:42, height:42, borderRadius:10, flexShrink:0, background:bg, display:"flex", alignItems:"center", justifyContent:"center"}}>
        <RpIc d={icon} size={18} sw={1.6} color={color}/>
      </div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginBottom:4}}>{label}</div>
        <div style={{fontSize:24, fontWeight:700, color:color||C.text, fontFamily:"'Playfair Display',serif", lineHeight:1, marginBottom:4}}>{value}</div>
        {sub && <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{sub}</div>}
      </div>
    </div>
  );
}

function ReportsPage() {
  const [period, setPeriod] = useState("Bu Ay");
  const PERIODS = ["Bugün","Bu Hafta","Bu Ay","Son 3 Ay"];

  const { data:rLeads, loading:rLeadsLoading, error:rLeadsError, reload:reloadLeads } = useRepo("lead",        "getAll");
  const { data:rQuotes }                                                              = useRepo("payment",     "getAll");
  const { data:rRes,   loading:rResLoading,  error:rResError,   reload:reloadRes }   = useRepo("reservation", "getAll");
  const { data:rPays,  loading:rPaysLoading, error:rPaysError,  reload:reloadPays }  = useRepo("payment",     "getAll");
  const { data:rCusts }                                                               = useRepo("customer",    "getAll");
  const isLoading = rLeadsLoading || rResLoading || rPaysLoading;

  const metrics = useMemo(
    () => calculateReportMetrics(period, rLeads, DB.quotes, rRes, rPays, rCusts),
    [period, rLeads, rRes, rPays, rCusts]
  );
  const kpi       = metrics.kpi;
  const convRate  = kpi.leads > 0 ? Math.round(kpi.reservations/kpi.leads*100) : 0;
  const maxLeads  = Math.max(1, ...metrics.sources.map(s=>s.leads));
  const maxRev    = Math.max(1, ...metrics.tours.map(t=>t.revenue));

  return (
    <div style={{display:"flex", flexDirection:"column", gap:20}}>

      {}
      {isLoading  ? <LoadingState label="Rapor verileri yükleniyor…"/> : null}
      {(rLeadsError || rResError || rPaysError) && (
        <ErrorState
          message="Rapor verileri yüklenirken bir hata oluştu."
          onRetry={()=>{ reloadLeads?.(); reloadRes?.(); reloadPays?.(); }}
        />
      )}

      {}
      <div className="page-header" style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"20px 24px",
        display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:20,
      }}>
        <div>
          <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:5}}>Raporlar</h1>
          <p style={{margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
            Satış, gelir, kaynak ve operasyon performansını tek ekrandan analiz edin.
          </p>
        </div>
        {}
        <div style={{display:"flex", alignItems:"center", gap:6, flexShrink:0, background:C.ivory, border:`1px solid ${C.border}`, borderRadius:9, padding:4}}>
          {PERIODS.map(p=>{
            const on=period===p;
            return (
              <button key={p} onClick={()=>setPeriod(p)} style={{
                padding:"6px 14px", borderRadius:7, cursor:"pointer",
                border:"none", background:on?C.navy:"transparent",
                color:on?C.white:C.textMuted,
                fontFamily:"'DM Sans',sans-serif", fontSize:13,
                fontWeight:on?500:400, transition:"all .12s",
              }}>{p}</button>
            );
          })}
        </div>
      </div>

      {}
      <div className="rsp-stat-grid-1" style={{display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12}}>
        <RpKpiCard label="Toplam Talep"           value={kpi.leads}                             icon="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"                                                  color={C.blue}  bg={C.blueBg}   sub={`${period} döneminde`}/>
        <RpKpiCard label="Gönderilen Teklif"      value={kpi.quotes}                            icon="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6"                                    color={C.amber} bg={C.amberBg}  sub={`${safePct(kpi.quotes, kpi.leads)} talep → teklif`}/>
        <RpKpiCard label="Kesinleşen Rezervasyon" value={kpi.reservations}                      icon="M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"                              color={C.green} bg={C.greenBg}  sub={`${kpi.completed} tur tamamlandı`}/>
        <RpKpiCard label="Dönüşüm Oranı"          value={`%${convRate}`}                        icon="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"                                                                      color={C.navy}  bg={C.ivoryDark} sub="Talep → Rezervasyon"/>
        <RpKpiCard label="Beklenen Gelir"          value={`€${kpi.expectedEur.toLocaleString("tr-TR")}`} icon="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"                                    color={C.gold}  bg={C.goldPale}  sub="EUR bazlı tüm rezervasyonlar" highlight/>
        <RpKpiCard label="Tahsil Edilen Gelir"    value={`€${kpi.collectedEur.toLocaleString("tr-TR")}`} icon="M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3"                                    color={C.green} bg={C.greenBg}  sub={`${safePct(kpi.collectedEur, kpi.expectedEur)} tahsil edildi`} highlight/>
      </div>

      {}
      <div style={{display:"grid", gridTemplateColumns: window.innerWidth < 1024 ? "1fr" : "1fr 280px", gap:20, alignItems:"start"}}>

        {}
        <div style={{display:"flex", flexDirection:"column", gap:20}}>

          {}
          <RpSection title="Satış Hunisi" icon="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" action={period}>
            <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12}}>
              {[
                { label:"Talep",           val:kpi.leads,        icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",                            color:C.blue,  pct:100 },
                { label:"Teklif",          val:kpi.quotes,       icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6",              color:C.amber, pct:safePctNum(kpi.quotes, kpi.leads) },
                { label:"Rezervasyon",     val:kpi.reservations, icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11",         color:C.gold,  pct:safePctNum(kpi.reservations, kpi.leads) },
                { label:"Tamamlanan Tur",  val:kpi.completed,    icon:"M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3",                         color:C.green, pct:safePctNum(kpi.completed, kpi.leads) },
              ].map((step,i)=>(
                <div key={i} style={{display:"flex", flexDirection:"column", alignItems:"center", gap:10, position:"relative"}}>
                  {}
                  {i>0 && (
                    <div style={{
                      position:"absolute", left:-16, top:28,
                      color:C.textFaint, fontSize:18, lineHeight:1,
                    }}>›</div>
                  )}
                  {}
                  <div style={{
                    width:"100%", padding:"18px 14px",
                    background:`linear-gradient(160deg, ${step.color}12 0%, ${step.color}06 100%)`,
                    border:`1.5px solid ${step.color}40`,
                    borderRadius:12, textAlign:"center",
                  }}>
                    <div style={{
                      width:38, height:38, borderRadius:10, margin:"0 auto 10px",
                      background:`${step.color}18`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      color:step.color,
                    }}>
                      <RpIc d={step.icon} size={17} sw={1.7} color={step.color}/>
                    </div>
                    <div style={{fontSize:28, fontWeight:700, color:step.color, fontFamily:"'Playfair Display',serif", lineHeight:1}}>{step.val}</div>
                    <div style={{fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:4}}>{step.label}</div>
                    <div style={{
                      marginTop:8, fontSize:11, fontWeight:600,
                      color:step.color, fontFamily:"'DM Sans',sans-serif",
                      background:`${step.color}14`, padding:"2px 8px", borderRadius:99,
                      display:"inline-block",
                    }}>%{step.pct}</div>
                  </div>
                </div>
              ))}
            </div>
          </RpSection>

          {}
          <RpSection title="Kaynak Performansı" icon="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z">
            {metrics.sources.length === 0 ? (
              <EmptyState icon="📊" title="Bu dönem için veri yok" subtitle="Seçilen tarih aralığında kaynak bazlı talep bulunmuyor."/>
            ) : (
            <table className="rsp-table" style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${C.border}`}}>
                  {["Kaynak","Talep","Teklif","Rezervasyon","Dönüşüm","Beklenen Gelir","Dağılım"].map((h,i)=>(
                    <th key={i} style={{
                      padding:"8px 10px", textAlign: i===0?"left":"center",
                      fontSize:10.5, fontWeight:600, color:C.textFaint,
                      fontFamily:"'DM Sans',sans-serif",
                      textTransform:"uppercase", letterSpacing:"0.07em",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.sources.map((s,i)=>{
                  return (
                    <tr key={i}
                      onMouseEnter={()=>setHov(true)}
                      onMouseLeave={()=>setHov(false)}
                      style={{background:C.white, transition:"background .1s"}}>
                      <td style={{padding:"12px 10px", borderBottom:`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <span style={{fontSize:13.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{s.source}</span>
                      </td>
                      {[s.leads, s.quotes, s.reservations].map((v,j)=>(
                        <td key={j} style={{padding:"12px 10px", borderBottom:`1px solid ${C.borderLight}`, textAlign:"center", verticalAlign:"middle"}}>
                          <span style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>{v}</span>
                        </td>
                      ))}
                      <td style={{padding:"12px 10px", borderBottom:`1px solid ${C.borderLight}`, textAlign:"center", verticalAlign:"middle"}}>
                        <span style={{
                          fontSize:12.5, fontWeight:600,
                          color: s.conversion>=30?C.green:s.conversion>=20?C.amber:C.red,
                          fontFamily:"'DM Sans',sans-serif",
                        }}>%{s.conversion}</span>
                      </td>
                      <td style={{padding:"12px 10px", borderBottom:`1px solid ${C.borderLight}`, textAlign:"center", verticalAlign:"middle"}}>
                        <span style={{fontSize:13, fontWeight:600, color:C.gold, fontFamily:"'Playfair Display',serif"}}>€{s.revenue.toLocaleString("tr-TR")}</span>
                      </td>
                      <td style={{padding:"12px 10px", borderBottom:`1px solid ${C.borderLight}`, verticalAlign:"middle", minWidth:80}}>
                        <MiniBar value={s.leads} max={maxLeads} color={C.navy} height={5}/>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            )}
          </RpSection>

          {}
          <RpSection title="En Çok Satan Turlar" icon="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10">
            {metrics.tours.length === 0 ? (
              <EmptyState icon="🗺️" title="Bu dönem için veri yok" subtitle="Seçilen tarih aralığında tamamlanan rezervasyon bulunmuyor."/>
            ) : (
            <div style={{display:"flex", flexDirection:"column", gap:12}}>
              {metrics.tours.map((t,i)=>(
                <div key={i} style={{
                  padding:"14px 16px", borderRadius:10,
                  background:C.ivory, border:`1px solid ${C.borderLight}`,
                  display:"flex", alignItems:"center", gap:16,
                }}>
                  {}
                  <div style={{
                    width:32, height:32, borderRadius:8, flexShrink:0,
                    background: i===0?C.navy:i===1?"rgba(27,45,79,0.15)":"rgba(27,45,79,0.07)",
                    display:"flex", alignItems:"center", justifyContent:"center",
                  }}>
                    <span style={{
                      fontSize:14, fontWeight:700,
                      color: i===0?C.goldLight:C.textMuted,
                      fontFamily:"'Playfair Display',serif",
                    }}>{i+1}</span>
                  </div>
                  {}
                  <div style={{flex:1, minWidth:0}}>
                    <div style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif", marginBottom:3}}>{t.name}</div>
                    <MiniBar value={t.revenue} max={maxRev} color={i===0?C.gold:C.blue} height={4}/>
                  </div>
                  {}
                  {[
                    { label:"Rezervasyon", val:t.reservations },
                    { label:"Misafir",     val:t.guests },
                  ].map((stat,j)=>(
                    <div key={j} style={{textAlign:"center", flexShrink:0}}>
                      <div style={{fontSize:18, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", lineHeight:1}}>{stat.val}</div>
                      <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2}}>{stat.label}</div>
                    </div>
                  ))}
                  {}
                  <div style={{textAlign:"right", flexShrink:0}}>
                    <div style={{fontSize:18, fontWeight:700, color:C.gold, fontFamily:"'Playfair Display',serif", lineHeight:1}}>€{t.revenue.toLocaleString("tr-TR")}</div>
                    <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2}}>Ort. €{t.avgPrice}/kişi</div>
                  </div>
                </div>
              ))}
            </div>
            )}
          </RpSection>

          {}
          <RpSection title="Ülke Analizi" icon="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z">
            {metrics.countries.length === 0 ? (
              <EmptyState icon="🌍" title="Bu dönem için veri yok" subtitle="Seçilen tarih aralığında ülke bazlı talep bulunmuyor."/>
            ) : (
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${C.border}`}}>
                  {["Ülke","Talep","Rezervasyon","Ort. Teklif","Pay"].map((h,i)=>(
                    <th key={i} style={{
                      padding:"8px 12px", textAlign:i===0?"left":"center",
                      fontSize:10.5, fontWeight:600, color:C.textFaint,
                      fontFamily:"'DM Sans',sans-serif",
                      textTransform:"uppercase", letterSpacing:"0.07em",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.countries.map((c,i)=>{
                  const maxLeadsC = Math.max(...metrics.countries.map(x=>x.leads));
                  const isTop = i===0;
                  return (
                    <tr key={i}
                      onMouseEnter={()=>setHov(true)}
                      onMouseLeave={()=>setHov(false)}
                      style={{background:C.white, transition:"background .1s"}}>
                      <td style={{padding:"11px 12px", borderBottom:`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <div style={{display:"flex", alignItems:"center", gap:8}}>
                          <span style={{fontSize:18}}>{c.flag}</span>
                          <span style={{fontSize:13.5, fontWeight:isTop?600:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{c.country}</span>
                          {isTop && <span style={{fontSize:10, color:C.gold, background:C.goldPale, padding:"1px 6px", borderRadius:4, fontFamily:"'DM Sans',sans-serif", fontWeight:600}}>En Çok</span>}
                        </div>
                      </td>
                      <td style={{padding:"11px 12px", borderBottom:`1px solid ${C.borderLight}`, textAlign:"center", verticalAlign:"middle"}}>
                        <span style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>{c.leads}</span>
                      </td>
                      <td style={{padding:"11px 12px", borderBottom:`1px solid ${C.borderLight}`, textAlign:"center", verticalAlign:"middle"}}>
                        <span style={{fontSize:14, fontWeight:600, color:C.green, fontFamily:"'Playfair Display',serif"}}>{c.reservations}</span>
                      </td>
                      <td style={{padding:"11px 12px", borderBottom:`1px solid ${C.borderLight}`, textAlign:"center", verticalAlign:"middle"}}>
                        <span style={{fontSize:13.5, fontWeight:600, color:C.gold, fontFamily:"'Playfair Display',serif"}}>€{c.avgQuote}</span>
                      </td>
                      <td style={{padding:"11px 12px", borderBottom:`1px solid ${C.borderLight}`, verticalAlign:"middle", minWidth:80}}>
                        <MiniBar value={c.leads} max={maxLeadsC} color={C.navy} height={5}/>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            )}
          </RpSection>

          {}
          <RpSection title="Ödeme Analizi" icon="M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20">
            <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:12, marginBottom:20}}>
              {[
                { label:"Toplam Beklenen", val:`€${metrics.payments.expected.toLocaleString("tr-TR")}`,   color:C.text,  bg:C.ivoryDark },
                { label:"Tahsil Edilen",   val:`€${metrics.payments.collected.toLocaleString("tr-TR")}`,  color:C.green, bg:C.greenBg },
                { label:"Bekleyen",        val:`€${metrics.payments.pending.toLocaleString("tr-TR")}`,    color:C.red,   bg:C.redBg },
                { label:"Kısmi Ödenen",    val:`€${metrics.payments.partial.toLocaleString("tr-TR")}`,    color:C.amber, bg:C.amberBg },
                { label:"İade",            val:`€${metrics.payments.refunded.toLocaleString("tr-TR")}`,   color:C.textFaint, bg:C.ivoryDark },
              ].map((r,i)=>(
                <div key={i} style={{
                  background:r.bg, border:`1px solid ${r.color}22`,
                  borderRadius:10, padding:"14px 12px", textAlign:"center",
                }}>
                  <div style={{fontSize:18, fontWeight:700, color:r.color, fontFamily:"'Playfair Display',serif", lineHeight:1, marginBottom:5}}>{r.val}</div>
                  <div style={{fontSize:11.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>{r.label}</div>
                </div>
              ))}
            </div>
            {}
            <div style={{marginBottom:20}}>
              <div style={{display:"flex", justifyContent:"space-between", marginBottom:6}}>
                <span style={{fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>Tahsilat Oranı</span>
                <span style={{fontSize:12.5, fontWeight:600, color:C.gold, fontFamily:"'DM Sans',sans-serif"}}>
                  {safePct(metrics.payments.collected, metrics.payments.expected)}
                </span>
              </div>
              <div style={{height:8, background:C.ivoryDark, borderRadius:99, overflow:"hidden"}}>
                <div style={{
                  width:`${safePctNum(metrics.payments.collected, metrics.payments.expected)}%`,
                  height:"100%",
                  background:`linear-gradient(90deg, ${C.green}, ${C.gold})`,
                  borderRadius:99,
                }}/>
              </div>
            </div>
            {}
            <div style={{fontSize:11.5, fontWeight:600, color:C.textFaint, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:"'DM Sans',sans-serif", marginBottom:10}}>
              Yüksek Tutarlı Bekleyenler
            </div>
            {metrics.payments.highValue.length === 0 ? (
              <div style={{fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontStyle:"italic", padding:"8px 2px"}}>
                Yüksek tutarlı bekleyen ödeme yok.
              </div>
            ) : metrics.payments.highValue.map((p,i)=>(
              <div key={i} style={{
                display:"flex", alignItems:"center", gap:12,
                padding:"10px 12px", borderRadius:8, marginBottom:7,
                background:p.urgent?C.redBg:C.ivory,
                border:`1px solid ${p.urgent?C.red+"33":C.borderLight}`,
              }}>
                <span style={{fontSize:18}}>{p.flag}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:13, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{p.guest}</div>
                  <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Mono',monospace"}}>{p.resId} · Son tarih: {p.dueDate}</div>
                </div>
                <div style={{fontSize:15, fontWeight:700, color:p.urgent?C.red:C.text, fontFamily:"'Playfair Display',serif", flexShrink:0}}>
                  €{p.remaining.toLocaleString("tr-TR")}
                </div>
                {p.urgent && <span style={{
                  fontSize:10, fontWeight:600, color:C.red,
                  background:C.redBg, border:`1px solid ${C.red}44`,
                  padding:"1px 7px", borderRadius:99, fontFamily:"'DM Sans',sans-serif",
                }}>ACİL</span>}
              </div>
            ))}
          </RpSection>

          {}
          <RpSection title="Operasyon Analizi" icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" action={period}>
            <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:12}}>
              {[
                { label:"Yaklaşan Turlar",       val:metrics.ops.upcoming,   color:C.blue,   bg:C.blueBg,   icon:"M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z" },
                { label:"Tamamlanan Turlar",      val:metrics.ops.completed,  color:C.green,  bg:C.greenBg,  icon:"M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3" },
                { label:"İptal Edilen",           val:metrics.ops.cancelled,  color:C.red,    bg:C.redBg,    icon:"M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" },
                { label:"Rehber Atanmayan",       val:metrics.ops.noGuide,    color:C.amber,  bg:C.amberBg,  icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75", alert:true },
                { label:"Pickup Bilgisi Eksik",   val:metrics.ops.noPickup,   color:"#6B3FA0",bg:"#F3EEF9",  icon:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a1 1 0 100-2 1 1 0 000 2z", alert:true },
              ].map((k,i)=>(
                <div key={i} style={{
                  background:k.bg, border:`1.5px solid ${k.alert?k.color+"44":k.color+"22"}`,
                  borderRadius:10, padding:"16px 12px", textAlign:"center",
                }}>
                  <div style={{
                    width:36, height:36, borderRadius:9, margin:"0 auto 10px",
                    background:k.alert?"rgba(255,255,255,0.6)":C.white,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    color:k.color,
                  }}>
                    <RpIc d={k.icon} size={17} sw={1.6} color={k.color}/>
                  </div>
                  <div style={{fontSize:26, fontWeight:700, color:k.color, fontFamily:"'Playfair Display',serif", lineHeight:1, marginBottom:4}}>
                    {k.alert && k.val>0 ? "⚠ " : ""}{k.val}
                  </div>
                  <div style={{fontSize:11.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", lineHeight:1.3}}>{k.label}</div>
                </div>
              ))}
            </div>
          </RpSection>

        </div>

        {}
        <div style={{position:"sticky", top:20}}>
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>

            {}
            <div style={{
              background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
              padding:"16px 18px",
              display:"flex", alignItems:"center", gap:10,
            }}>
              <div style={{
                width:30, height:30, borderRadius:7, flexShrink:0,
                background:"rgba(201,168,76,0.2)", border:"1px solid rgba(201,168,76,0.3)",
                display:"flex", alignItems:"center", justifyContent:"center",
              }}>
                <RpIc d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" size={15} sw={1.8} color={C.goldLight}/>
              </div>
              <div>
                <div style={{fontSize:14, fontWeight:600, color:C.ivory, fontFamily:"'Playfair Display',serif"}}>Yönetici Özeti</div>
                <div style={{fontSize:11.5, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Sans',sans-serif"}}>{period} · Otomatik güncellendi</div>
              </div>
            </div>

            {}
            <div style={{padding:"12px 14px", display:"flex", flexDirection:"column", gap:8}}>
              {[
                {
                  icon:"M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
                  color:C.green, bg:C.greenBg,
                  label:"En Güçlü Kaynak",
                  value:"Website",
                  sub:`${metrics.sources[0].leads} talep · %${metrics.sources[0].conversion} dönüşüm`,
                },
                {
                  icon:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10",
                  color:C.gold, bg:C.goldPale,
                  label:"En Çok Satan Tur",
                  value:"Private Istanbul",
                  sub:`${metrics.tours[0].reservations} rezervasyon · €${metrics.tours[0].revenue.toLocaleString("tr-TR")}`,
                },
                {
                  icon:"M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
                  color:C.blue, bg:C.blueBg,
                  label:"En Yüksek Ortalama",
                  value:"ABD — €460",
                  sub:"Kişi başı ortalama teklif",
                },
                {
                  icon:"M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
                  color:C.amber, bg:C.amberBg,
                  label:"Bekleyen Ödeme",
                  value:"€5.650",
                  sub:"3 rezervasyon · Bu ay",
                },
                {
                  icon:"M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z",
                  color:C.red, bg:C.redBg,
                  label:"Operasyon Uyarısı",
                  value:"3 Rehber Eksik",
                  sub:"Tur öncesi atama yapılmalı",
                },
              ].map((ins,i)=>(
                <div key={i} style={{
                  padding:"12px 12px", borderRadius:9,
                  background:ins.bg, border:`1px solid ${ins.color}22`,
                }}>
                  <div style={{display:"flex", alignItems:"flex-start", gap:10}}>
                    <div style={{
                      width:28, height:28, borderRadius:7, flexShrink:0,
                      background:"rgba(255,255,255,0.5)",
                      display:"flex", alignItems:"center", justifyContent:"center",
                    }}>
                      <RpIc d={ins.icon} size={14} sw={1.7} color={ins.color}/>
                    </div>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontSize:10.5, color:ins.color, fontFamily:"'DM Sans',sans-serif", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:2}}>{ins.label}</div>
                      <div style={{fontSize:14, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", lineHeight:1.2, marginBottom:2}}>{ins.value}</div>
                      <div style={{fontSize:11.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>{ins.sub}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {}
            <div style={{
              padding:"12px 14px", borderTop:`1px solid ${C.borderLight}`,
              background:C.ivory,
            }}>
              <div style={{
                display:"flex", alignItems:"center", gap:7,
                fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
              }}>
                <RpIc d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" size={13} sw={1.6} color={C.textFaint}/>
                Rapor dışa aktarma V2'de aktif olacak
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

const GUEST_STATUS_CFG = {
  "Aktif":              { color:"#2E7D52", bg:"#EBF5EF", dot:"#2E7D52" },
  "Rezervasyonu Var":   { color:"#1A6FAE", bg:"#E8F2FB", dot:"#1A6FAE" },
  "Tekrar Gelen":       { color:"#B8973A", bg:"#F5EDD4", dot:"#B8973A" },
  "Teklif Bekliyor":    { color:"#B45309", bg:"#FEF3E2", dot:"#B45309" },
  "Arşiv":              { color:"#6B7280", bg:"#F3F4F6", dot:"#9CA3AF" },
};

const MOCK_GUESTS = [
  {
    id:"MSF-001",
    name:"Sarah Johnson",      initials:"SJ", flag:"????", country:"Avustralya", language:"İngilizce",
    phone:"+61 412 855 903",   email:"sarah.johnson@email.com",
    firstContact:"03 Haz 2026", lastContact:"Dün",
    status:"Teklif Bekliyor",
    leads:1, quotes:1, reservations:0,
    totalSpend:0, currency:"EUR",
    openTasks:2,
    notes:"Boğaz turu seçeneğiyle ilgileniyor. Özel deneyimler tercih ediyor. VIP misafir.",
    tags:["VIP","Yeni"],
    relatedLeads:[
      { date:"03 Haz 2026", source:"Booking.com", tour:"Private Istanbul Experience", status:"Teklif Gönderildi", id:"LEAD-001" },
    ],
    relatedQuotes:[
      { id:"Q-2026-001", tour:"Private Istanbul Experience", amount:"€3.600", status:"Gönderildi", date:"04 Haz 2026" },
    ],
    relatedReservations:[],
    timeline:[
      { date:"03 Haz", action:"Talep oluşturuldu",       detail:"Booking.com üzerinden Private Istanbul Experience talebi.",  type:"lead",    who:"Sistem",          time:"09:14" },
      { date:"03 Haz", action:"Telefon görüşmesi yapıldı",detail:"18 dakika görüşme. Tur detayları ve özel tercihler konuşuldu.",type:"call",  who:"Berk Çetinkaya", time:"14:32" },
      { date:"04 Haz", action:"Teklif gönderildi",        detail:"€3.600 tutarında Private Istanbul Experience teklifi e-posta ile iletildi.", type:"quote", who:"Berk Çetinkaya", time:"11:05" },
      { date:"05 Haz", action:"Müşteri geri döndü",       detail:"Boğaz turu seçeneği hakkında bilgi istedi.",                 type:"reply",   who:"Sarah Johnson",   time:"16:48" },
    ],
  },
  {
    id:"MSF-002",
    name:"Emma Brown",         initials:"EB", flag:"????", country:"ABD",          language:"İngilizce",
    phone:"+1 310 555 0192",   email:"emma.brown@email.com",
    firstContact:"01 Haz 2026", lastContact:"Bugün",
    status:"Rezervasyonu Var",
    leads:2, quotes:2, reservations:1,
    totalSpend:5200, currency:"EUR",
    openTasks:1,
    notes:"6 kişilik grup. Ekstra su ve ikram hazırlanacak. Tur lideri kendisi.",
    tags:["Grup"],
    relatedLeads:[
      { date:"01 Haz 2026", source:"WhatsApp",  tour:"Bosphorus & Asian Side Tour", status:"Onaylandı",    id:"LEAD-003" },
      { date:"28 May 2026", source:"Instagram", tour:"Old City Tour",                status:"İptal",        id:"LEAD-009" },
    ],
    relatedQuotes:[
      { id:"Q-2026-002", tour:"Bosphorus & Asian Side Tour", amount:"€5.200", status:"Onaylandı", date:"02 Haz 2026" },
      { id:"Q-2026-009", tour:"Old City Tour",                amount:"€2.100", status:"Reddedildi",date:"29 May 2026" },
    ],
    relatedReservations:[
      { id:"R-2026-002", tour:"Bosphorus & Asian Side Tour", date:"20 Haz 2026", pax:6, opStatus:"Hazırlanıyor", payStatus:"Ödendi" },
    ],
    timeline:[
      { date:"28 May", action:"Talep oluşturuldu",        detail:"Instagram üzerinden Old City Tour talebi.",               type:"lead",    who:"Sistem",          time:"10:21" },
      { date:"29 May", action:"Teklif gönderildi",         detail:"€2.100 Old City Tour teklifi iletildi.",                  type:"quote",   who:"Berk Çetinkaya", time:"14:00" },
      { date:"01 Haz", action:"Talep oluşturuldu",         detail:"WhatsApp üzerinden Bosphorus talebi.",                   type:"lead",    who:"Sistem",          time:"09:33" },
      { date:"02 Haz", action:"Teklif gönderildi",         detail:"€5.200 Bosphorus & Asian Side Tour teklifi iletildi.",   type:"quote",   who:"Berk Çetinkaya", time:"11:15" },
      { date:"03 Haz", action:"Ödeme alındı",              detail:"€5.200 tam ödeme kredi kartı ile alındı.",               type:"payment", who:"Berk Çetinkaya", time:"16:20" },
      { date:"03 Haz", action:"Rezervasyon oluşturuldu",   detail:"R-2026-002 · 20 Haziran Bosphorus turu.",                type:"reservation",who:"Berk Çetinkaya",time:"16:25" },
    ],
  },
  {
    id:"MSF-003",
    name:"Ayşe Demir",         initials:"AD", flag:"????", country:"Türkiye",      language:"Türkçe",
    phone:"+90 532 111 2233",  email:"ayse.demir@email.com",
    firstContact:"02 Haz 2026", lastContact:"2 gün önce",
    status:"Aktif",
    leads:1, quotes:1, reservations:1,
    totalSpend:18000, currency:"TRY",
    openTasks:0,
    notes:"Balayı çifti. Sürpriz çiçek ve şampanya organizasyonu istendi. Özel ilgi gerektirir.",
    tags:["Balayı","VIP"],
    relatedLeads:[
      { date:"02 Haz 2026", source:"Telefon", tour:"Özel Kapadokya Turu", status:"Onaylandı", id:"LEAD-004" },
    ],
    relatedQuotes:[
      { id:"Q-2026-004", tour:"Özel Kapadokya Turu", amount:"₺18.000", status:"Onaylandı", date:"02 Haz 2026" },
    ],
    relatedReservations:[
      { id:"R-2026-003", tour:"Özel Kapadokya Turu", date:"25 Haz 2026", pax:3, opStatus:"Hazır", payStatus:"Ödendi" },
    ],
    timeline:[
      { date:"02 Haz", action:"Talep oluşturuldu",       detail:"Telefon görüşmesi ile Kapadokya turu talebi alındı.",    type:"lead",    who:"Berk Çetinkaya", time:"11:00" },
      { date:"02 Haz", action:"Teklif gönderildi",        detail:"₺18.000 Özel Kapadokya teklifi e-posta ile iletildi.", type:"quote",   who:"Berk Çetinkaya", time:"14:30" },
      { date:"02 Haz", action:"Ödeme alındı",             detail:"₺18.000 tam ödeme banka transferi ile alındı.",        type:"payment", who:"Berk Çetinkaya", time:"17:00" },
      { date:"02 Haz", action:"Rezervasyon oluşturuldu",  detail:"R-2026-003 · 25 Haziran Kapadokya turu.",              type:"reservation",who:"Berk Çetinkaya",time:"17:05" },
    ],
  }
];;

const TIMELINE_TYPE_META2 = {
  lead:        { color:"#1A6FAE", bg:"#E8F2FB",   icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
  call:        { color:"#4A5568", bg:"#F0EEF5",   icon:"M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.09-1.09a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" },
  quote:       { color:"#B8973A", bg:"#F5EDD4",   icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6" },
  reply:       { color:"#2E7D52", bg:"#EBF5EF",   icon:"M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" },
  payment:     { color:"#C05621", bg:"#FEF0E8",   icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20" },
  reservation: { color:"#1B2D4F", bg:"#E5EAF2",   icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
  complete:    { color:"#2E7D52", bg:"#EBF5EF",   icon:"M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3" },
};

function GIc({ d, size=15, sw=1.6, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color||"currentColor"} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d}/>
    </svg>
  );
}

function GStatusBadge({ status, small }) {
  const m = GUEST_STATUS_CFG[status] || { color:"#6B7280", bg:"#F3F4F6", dot:"#9CA3AF" };
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding: small ? "3px 8px" : "4px 11px",
      borderRadius:99, fontSize: small ? 11 : 12, fontWeight:500,
      color:m.color, background:m.bg, whiteSpace:"nowrap",
      fontFamily:"'DM Sans',sans-serif",
    }}>
      <span style={{width:6, height:6, borderRadius:"50%", background:m.dot, flexShrink:0}}/>
      {status}
    </span>
  );
}

function GSection({ title, icon, children, noPad }) {
  return (
    <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
      <div style={{
        padding:"13px 20px", background:C.ivory, borderBottom:`1px solid ${C.borderLight}`,
        display:"flex", alignItems:"center", gap:8,
      }}>
        <div style={{width:28, height:28, borderRadius:7, background:C.navy, display:"flex", alignItems:"center", justifyContent:"center"}}>
          <GIc d={icon} size={13} sw={1.8} color={C.goldLight}/>
        </div>
        <span style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif"}}>{title}</span>
      </div>
      <div style={noPad ? {} : {padding:"16px 20px"}}>{children}</div>
    </div>
  );
}

function GInfoRow({ label, value, mono, icon }) {
  return (
    <div style={{
      display:"flex", justifyContent:"space-between", alignItems:"flex-start",
      padding:"10px 20px", borderBottom:`1px solid ${C.borderLight}`,
    }}>
      <span style={{
        fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
        flexShrink:0, minWidth:120, paddingTop:1,
        display:"flex", alignItems:"center", gap:5,
      }}>
        {icon && <GIc d={icon} size={12} sw={1.5}/>}
        {label}
      </span>
      <span style={{
        fontSize:13, color:C.text, textAlign:"right",
        fontFamily: mono?"'DM Mono',monospace":"'DM Sans',sans-serif",
      }}>{value||"—"}</span>
    </div>
  );
}

function GuestTimeline({ events }) {
  return (
    <div style={{padding:"16px 20px 8px", position:"relative"}}>
      <div style={{position:"absolute", left:38, top:24, bottom:12, width:1, background:C.borderLight}}/>
      {events.map((ev,i)=>{
        const m = TIMELINE_TYPE_META2[ev.type] || TIMELINE_TYPE_META2.lead;
        return (
          <div key={i} style={{display:"flex", gap:14, alignItems:"flex-start", paddingBottom: i<events.length-1?18:4}}>
            <div style={{
              width:30, height:30, borderRadius:"50%", flexShrink:0,
              background:C.white, border:`2px solid ${m.color}`,
              display:"flex", alignItems:"center", justifyContent:"center",
              color:m.color, position:"relative", zIndex:1,
            }}>
              <GIc d={m.icon} size={12} sw={1.8} color={m.color}/>
            </div>
            <div style={{flex:1, paddingTop:3}}>
              <div style={{display:"flex", alignItems:"baseline", gap:8, marginBottom:3, flexWrap:"wrap"}}>
                <span style={{
                  fontSize:11, fontWeight:600, color:"#fff",
                  background:m.color, padding:"1px 7px", borderRadius:4,
                  fontFamily:"'DM Sans',sans-serif",
                }}>{ev.date}</span>
                <span style={{fontSize:13, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{ev.action}</span>
                <span style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginLeft:"auto"}}>{ev.time}</span>
              </div>
              <div style={{fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", lineHeight:1.5}}>{ev.detail}</div>
              <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:3}}>— {ev.who}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GuestDetailPage({ guestId, onBack, onNavigate }) {
  const { isMobile } = useBreakpoint();
  const _sp = safeParam(guestId);
  if (_sp.invalid) return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:60,gap:16}}>
      <div style={{fontSize:36}}>🔍</div>
      <div style={{fontSize:16,fontWeight:600,color:'#1B2D4F',fontFamily:"'Playfair Display',serif"}}>Kayıt bulunamadı</div>
      <div style={{fontSize:13,color:'#6B7280'}}>
        {_sp.reason==='demo' ? 'Bu demo kayıt Supabase modunda görüntülenemez.' : 'Geçersiz kayıt kimliği.'}
      </div>
      <button onClick={onBack} style={{padding:'9px 20px',borderRadius:8,border:'none',background:'#1B2D4F',color:'#fff',cursor:'pointer',fontSize:13}}>Geri Dön</button>
    </div>
  );

  const { data:rawCust, loading:guestLoading, error:guestError }
    = useRepo("customer", "getById", guestId);
  // Real per-customer aggregates for the Supabase path below — enrichCustomer()
  // only ever resolves against the in-memory mock arrays, so a real guest must
  // be enriched from these instead of trusting it to succeed.
  const { data:custLeads }    = useRepo("lead",        "getByCustomerId", guestId);
  const { data:custQuotes }   = useRepo("quote",       "getByCustomerId", guestId);
  const { data:custRes }      = useRepo("reservation", "getByCustomerId", guestId);
  const { data:custTasks }    = useRepo("task",        "getByCustomerId", guestId);
  const { data:custPays }     = useRepo("payment",     "getByCustomerId", guestId);
  const { data:custActivity } = useRepo("activity",    "getByCustomerId", guestId);
  const { sources } = useSources();

  const ACTIVITY_ACTION_LABEL = {
    created:"Oluşturuldu", updated:"Güncellendi", status_changed:"Durum güncellendi",
    sent:"Gönderildi", approved:"Onaylandı", payment:"Ödeme alındı", deposit:"Kapora alındı",
    call:"Arama yapıldı", reply:"Yanıt alındı", cancelled:"İptal edildi",
  };

  // In Supabase mode, a missing/blocked record must never be masked by mock data.
  // Mock demo data is only used when the app is genuinely running in Mock mode.
  const mockEnriched = rawCust ? enrichCustomer(rawCust.id) : null;
  const g = mockEnriched || (rawCust ? {
    ...rawCust,
    leads: (custLeads||[]).length,
    quotes: (custQuotes||[]).length,
    reservations: (custRes||[]).length,
    openTasks: (custTasks||[]).filter(t=>t.status!=="Tamamlandı").length,
    totalSpend: (custPays||[]).filter(p=>["Ödendi","Kapora Ödendi","Kısmi Ödendi"].includes(p.status)).reduce((s,p)=>s+(parseFloat(p.amount)||0),0),
    currency: custPays?.[0]?.currency || custRes?.[0]?.currency || "EUR",
    relatedLeads: (custLeads||[]).map(l => ({
      id:l.id, date:l.dateRange||l.ago||"—",
      source:(sources||[]).find(s=>s.id===l.sourceId)?.name || "—",
      tour:l.tour||"—", status:l.status,
    })),
    relatedQuotes: (custQuotes||[]).map(q => ({
      id:q.id, tour:q.tour||"—",
      amount:`${q.currency==="TRY"?"₺":"€"}${(q.total||0).toLocaleString("tr-TR")}`,
      status:q.status, date:q.dateRange||q.createdAt||"—",
    })),
    relatedReservations: (custRes||[]).map(r => ({
      id:r.id, tour:r.tour||"—", date:r.date||"—", pax:r.pax||1,
      opStatus:r.opStatus, payStatus:r.payStatus,
    })),
    timeline: (custActivity||[]).map(a => ({
      ...a, action: ACTIVITY_ACTION_LABEL[a.action] || a.action || "Güncellendi",
    })),
  } : (!AppConfig.useSupabase && MOCK_GUESTS ? (MOCK_GUESTS.find(x=>x.id===guestId)||MOCK_GUESTS[0]) : null));

  const [activeTab, setActiveTab] = useState("genel");

  const sm = GUEST_STATUS_CFG[(g||{}).status] || {};

  if (guestLoading) return <LoadingState label="Misafir profili yükleniyor…"/>;
  if (guestError)   return <ErrorState message={guestError} onRetry={()=>{}}/>;
  if (!g) return <div style={{padding:40,textAlign:"center",color:C.textFaint,fontFamily:"'DM Sans',sans-serif"}}>Misafir bulunamadı.</div>;

  const QUICK_ACTIONS = [
    { label:"Yeni Talep Oluştur",       icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", primary:true },
    { label:"Yeni Teklif Oluştur",      icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6" },
    { label:"Yeni Rezervasyon",         icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
    { label:"Not Ekle",                 icon:"M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
    { label:"Görev Oluştur",            icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
    { label:"Hatırlatma Oluştur",       icon:"M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" },
    { label:"WhatsApp Gönder",          icon:"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z", wa:true },
  ];

  return (
    <div style={{display:"flex", flexDirection:"column", gap:20}}>

      {}
      <div style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding: isMobile ? "14px 16px" : "15px 22px",
        display:"flex", flexDirection: isMobile ? "column" : "row",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent:"space-between", gap: isMobile ? 12 : 16,
      }}>
        <div style={{display:"flex", alignItems:"center", gap:14, minWidth:0}}>
          <button onClick={onBack} style={{
            display:"flex", alignItems:"center", gap:6, flexShrink:0,
            background:C.ivory, border:`1px solid ${C.border}`,
            borderRadius:7, padding:"6px 12px", cursor:"pointer",
            color:C.textMid, fontFamily:"'DM Sans',sans-serif", fontSize:12.5,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.ivoryDark}
            onMouseLeave={e=>e.currentTarget.style.background=C.ivory}
          >
            <GIc d="M15 18l-6-6 6-6" size={13} sw={2}/>
            {!isMobile && "Misafirler"}
          </button>
          {!isMobile && <div style={{width:1, height:20, background:C.borderLight, flexShrink:0}}/>}
          {}
          {!isMobile && (
            <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Mono',monospace", background:C.ivory, border:`1px solid ${C.borderLight}`, padding:"3px 8px", borderRadius:5, flexShrink:0}}>{g.id}</span>
          )}
          <div style={{minWidth:0}}>
            <div style={{fontSize:17, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", lineHeight:1.2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace: isMobile ? "nowrap" : "normal"}}>
              {g.flag} {g.name}
            </div>
            <div style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2}}>
              {g.country} · {g.language} · {g.firstContact}'dan beri
            </div>
          </div>
        </div>
        <div style={{display:"flex", alignItems:"center", gap:10, flexWrap:"wrap", flexShrink:0}}>
          {g.tags.map((t,i)=>(
            <span key={i} style={{
              fontSize:11, fontWeight:500, color:C.gold,
              background:C.goldPale, border:`1px solid ${C.gold}33`,
              padding:"2px 8px", borderRadius:5, fontFamily:"'DM Sans',sans-serif",
            }}>{t}</span>
          ))}
          {!isMobile && <div style={{width:1, height:20, background:C.borderLight}}/>}
          <GStatusBadge status={g.status}/>
        </div>
      </div>

      {}
      <div className="rsp-stat-grid" style={{display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:14}}>
        {[
          { label:"Toplam Talep",      val:g.leads,        icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", color:C.blue, bg:C.blueBg },
          { label:"Toplam Teklif",     val:g.quotes,       icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6", color:C.amber,bg:C.amberBg },
          { label:"Rezervasyon",       val:g.reservations, icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", color:C.green,bg:C.greenBg },
          { label:"Toplam Harcama",    val: g.totalSpend>0?`${g.currency==="TRY"?"₺":"€"}${g.totalSpend.toLocaleString("tr-TR")}`:"—", icon:"M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6", color:C.gold, bg:C.goldPale },
          { label:"Açık Görev",        val:g.openTasks,    icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", color:g.openTasks>0?C.red:C.green, bg:g.openTasks>0?C.redBg:C.greenBg },
        ].map((k,i)=>(
          <div key={i} style={{
            background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
            padding:"14px 16px", display:"flex", alignItems:"center", gap:12,
          }}>
            <div style={{width:36, height:36, borderRadius:9, flexShrink:0, background:k.bg, display:"flex", alignItems:"center", justifyContent:"center"}}>
              <GIc d={k.icon} size={16} sw={1.6} color={k.color}/>
            </div>
            <div>
              <div style={{fontSize:20, fontWeight:700, color:k.color, fontFamily:"'Playfair Display',serif", lineHeight:1}}>{k.val}</div>
              <div style={{fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:3}}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {}
      <div className="rsp-split" style={{display:"grid", gridTemplateColumns:"1fr 280px", gap:20, alignItems:"start"}}>

        {}
        <div style={{display:"flex", flexDirection:"column", gap:18}}>

          {}
          <div style={{
            background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
            padding:"0 20px", display:"flex", alignItems:"center", overflowX:"auto",
          }}>
            {[
              {k:"genel",        label:"Genel Bakış"},
              {k:"leads",        label:`Talepler (${g.leads})`},
              {k:"quotes",       label:`Teklifler (${g.quotes})`},
              {k:"reservations", label:`Rezervasyonlar (${g.reservations})`},
              {k:"timeline",     label:"Aktiviteler"},
            ].map(({k,label})=>{
              const on = activeTab===k;
              return (
                <button key={k} onClick={()=>setActiveTab(k)} style={{
                  padding:"13px 14px",
                  border:"none", borderBottom: on?`2px solid ${C.gold}`:"2px solid transparent",
                  background:"transparent", marginBottom:-1,
                  color: on?C.gold:C.textMuted,
                  fontFamily:"'DM Sans',sans-serif", fontSize:13,
                  fontWeight:on?600:400, cursor:"pointer", whiteSpace:"nowrap",
                  transition:"color .12s",
                }}>{label}</button>
              );
            })}
          </div>

          {}

          {}
          {activeTab==="genel" && (
            <div style={{display:"flex", flexDirection:"column", gap:18}}>
              <GSection title="Misafir Profili" icon="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75">
                <div style={{
                  background:`linear-gradient(160deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
                  margin:"-16px -20px 0", padding:"20px 20px 16px",
                  display:"flex", alignItems:"center", gap:14,
                }}>
                  <div style={{
                    width:56, height:56, borderRadius:"50%", flexShrink:0,
                    background:"rgba(201,168,76,0.18)", border:"2px solid rgba(201,168,76,0.4)",
                    display:"flex", alignItems:"center", justifyContent:"center",
                  }}>
                    <span style={{fontSize:20, fontWeight:700, color:C.goldLight, fontFamily:"'Playfair Display',serif"}}>{g.initials}</span>
                  </div>
                  <div>
                    <div style={{fontSize:20, fontWeight:700, color:C.ivory, fontFamily:"'Playfair Display',serif", lineHeight:1.2}}>{g.name}</div>
                    <div style={{fontSize:13, color:"rgba(248,245,238,0.6)", fontFamily:"'DM Sans',sans-serif", marginTop:4}}>
                      {g.flag} {g.country} · {g.language}
                    </div>
                  </div>
                </div>
                <GInfoRow label="Telefon"          value={g.phone}        mono icon="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.09-1.09a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
                <GInfoRow label="E-posta"           value={g.email}        mono icon="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6"/>
                <GInfoRow label="Ülke"              value={`${g.flag} ${g.country}`}/>
                <GInfoRow label="Dil"               value={g.language}/>
                <GInfoRow label="İlk Temas"         value={g.firstContact}/>
                <GInfoRow label="Son İletişim"      value={g.lastContact}/>
                <div style={{padding:"10px 20px", display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                  <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>Durum</span>
                  <GStatusBadge status={g.status} small/>
                </div>
              </GSection>

              {}
              <GSection title="Son Aktiviteler" icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z">
                <GuestTimeline events={g.timeline.slice(-3).reverse()}/>
              </GSection>
            </div>
          )}

          {}
          {activeTab==="leads" && (
            <GSection title={`Talepler (${g.leads})`} icon="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" noPad>
              {g.relatedLeads.length===0 ? (
                <div style={{padding:"48px 24px", textAlign:"center", color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontSize:13}}>Bu misafire ait talep bulunmuyor.</div>
              ) : (
                <table style={{width:"100%", borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`, background:C.ivory}}>
                      {["Tarih","Kaynak","Tur","Durum",""].map((h,i)=>(
                        <th key={i} style={{padding:"10px 16px", textAlign:"left", fontSize:10.5, fontWeight:600, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.07em"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {g.relatedLeads.map((lead,i)=>{
                      return (
                        <tr key={i} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{background:C.white, cursor:"pointer", transition:"background .1s"}}>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`, fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{lead.date}</td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`}}>
                            <span style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{lead.source}</span>
                          </td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`, fontSize:13, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{lead.tour}</td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`}}>
                            <span style={{
                              fontSize:12, padding:"3px 9px", borderRadius:99, fontFamily:"'DM Sans',sans-serif", fontWeight:500,
                              ...({color:(STATUS_META[lead.status]||{color:C.textMuted}).color, background:(STATUS_META[lead.status]||{bg:C.ivoryDark}).bg}),
                            }}>{lead.status}</span>
                          </td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`}}>
                            <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Mono',monospace"}}>{lead.id}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </GSection>
          )}

          {}
          {activeTab==="quotes" && (
            <GSection title={`Teklifler (${g.quotes})`} icon="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6" noPad>
              {g.relatedQuotes.length===0 ? (
                <div style={{padding:"48px 24px", textAlign:"center", color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontSize:13}}>Bu misafire ait teklif bulunmuyor.</div>
              ) : (
                <table style={{width:"100%", borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`, background:C.ivory}}>
                      {["Teklif No","Tur","Tutar","Durum","Tarih"].map((h,i)=>(
                        <th key={i} style={{padding:"10px 16px", textAlign:"left", fontSize:10.5, fontWeight:600, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.07em"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {g.relatedQuotes.map((q,i)=>{
                      const qm = QUOTE_STATUS[q.status]||{color:C.textMuted,bg:C.ivoryDark};
                      return (
                        <tr key={i} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{background:C.white, cursor:"pointer", transition:"background .1s"}}>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`}}>
                            <span style={{fontSize:12, fontWeight:600, color:C.navy, fontFamily:"'DM Mono',monospace", background:C.ivory, border:`1px solid ${C.borderLight}`, padding:"2px 7px", borderRadius:5}}>{q.id}</span>
                          </td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`, fontSize:13, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{q.tour}</td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`, fontSize:15, fontWeight:700, color:C.gold, fontFamily:"'Playfair Display',serif"}}>{q.amount}</td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`}}>
                            <span style={{fontSize:12, padding:"3px 9px", borderRadius:99, fontFamily:"'DM Sans',sans-serif", fontWeight:500, color:qm.color, background:qm.bg}}>{q.status}</span>
                          </td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`, fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{q.date}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </GSection>
          )}

          {}
          {activeTab==="reservations" && (
            <GSection title={`Rezervasyonlar (${g.reservations})`} icon="M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" noPad>
              {g.relatedReservations.length===0 ? (
                <div style={{padding:"48px 24px", textAlign:"center", color:C.textFaint, fontFamily:"'DM Sans',sans-serif", fontSize:13}}>Bu misafire ait rezervasyon bulunmuyor.</div>
              ) : (
                <table style={{width:"100%", borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`, background:C.ivory}}>
                      {["Rezervasyon No","Tur","Tarih","Kişi","Operasyon","Ödeme"].map((h,i)=>(
                        <th key={i} style={{padding:"10px 16px", textAlign:"left", fontSize:10.5, fontWeight:600, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.07em"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {g.relatedReservations.map((r,i)=>{
                      const rsm = RES_STATUS[r.opStatus]||{color:C.textMuted,bg:C.ivoryDark};
                      const rpm = PAY_STATUS_MAP[r.payStatus]||{color:C.textMuted,bg:C.ivoryDark};
                      return (
                        <tr key={i} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{background:C.white, cursor:"pointer", transition:"background .1s"}}>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`}}>
                            <span style={{fontSize:12, fontWeight:600, color:C.navy, fontFamily:"'DM Mono',monospace", background:C.ivory, border:`1px solid ${C.borderLight}`, padding:"2px 7px", borderRadius:5}}>{r.id}</span>
                          </td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`, fontSize:13, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{r.tour}</td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`, fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{r.date}</td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`, fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{r.pax} kişi</td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`}}>
                            <span style={{fontSize:12, padding:"3px 9px", borderRadius:99, fontFamily:"'DM Sans',sans-serif", fontWeight:500, color:rsm.color, background:rsm.bg}}>{r.opStatus}</span>
                          </td>
                          <td style={{padding:"12px 16px", borderBottom:`1px solid ${C.borderLight}`}}>
                            <span style={{fontSize:12, padding:"3px 9px", borderRadius:99, fontFamily:"'DM Sans',sans-serif", fontWeight:500, color:rpm.color, background:rpm.bg}}>{r.payStatus}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </GSection>
          )}

          {}
          {activeTab==="timeline" && (
            <GSection title="Aktivite Zaman Çizelgesi" icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z">
              <GuestTimeline events={[...g.timeline].reverse()}/>
            </GSection>
          )}
        </div>

        {}
        <div style={{display:"flex", flexDirection:"column", gap:18}}>

          {}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
            <div style={{
              background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
              padding:"14px 16px",
            }}>
              <div style={{fontSize:13.5, fontWeight:600, color:C.ivory, fontFamily:"'Playfair Display',serif"}}>Hızlı İşlemler</div>
            </div>
            <div style={{padding:"10px"}}>
              {QUICK_ACTIONS.map((a,i)=>{
                return (
                  <button key={i}
                    onMouseEnter={e=>e.currentTarget.style.background=e.currentTarget.dataset.hover||C.ivory}
                    onMouseLeave={e=>e.currentTarget.style.background=""}
                    style={{
                      display:"flex", alignItems:"center", gap:9, width:"100%",
                      padding:"9px 11px", borderRadius:7, marginBottom:i<QUICK_ACTIONS.length-1?5:0,
                      border: a.primary?"none": a.wa?`1px solid #128C7E44`:`1px solid ${C.border}`,
                      background: a.primary?C.navy: a.wa?"#F2FAF8":C.white,
                      cursor:"pointer",
                      color: a.primary?C.white: a.wa?"#128C7E":C.text,
                      fontFamily:"'DM Sans',sans-serif", fontSize:12.5,
                      fontWeight:a.primary?600:400, textAlign:"left", transition:"background .12s",
                    }}>
                    <GIc d={a.icon} size={13} sw={a.primary?2:1.6}/>
                    {a.label}
                  </button>
                );
              })}
            </div>
          </div>

          {}
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
            <div style={{padding:"13px 16px", background:C.ivory, borderBottom:`1px solid ${C.borderLight}`}}>
              <span style={{fontSize:12, fontWeight:600, color:C.textFaint, textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:"'DM Sans',sans-serif"}}>Misafir Notları</span>
            </div>
            <div style={{padding:"14px 16px"}}>
              <div style={{
                fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif",
                lineHeight:1.65, background:C.ivory, borderRadius:8, padding:"12px 14px",
                border:`1px solid ${C.borderLight}`,
              }}>
                {g.notes}
              </div>
              <button style={{
                marginTop:10, width:"100%", padding:"8px", borderRadius:7, cursor:"pointer",
                border:`1px dashed ${C.border}`, background:C.white, color:C.textFaint,
                fontSize:12.5, fontFamily:"'DM Sans',sans-serif",
                display:"flex", alignItems:"center", justifyContent:"center", gap:6,
              }}
                onMouseEnter={e=>{ e.currentTarget.style.borderColor=C.navy; e.currentTarget.style.color=C.navy; }}
                onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.color=C.textFaint; }}
              >
                <GIc d="M12 5v14M5 12h14" size={12} sw={2}/>
                Not Ekle
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomersPage({ onSelectGuest }) {
  const { isMobile } = useBreakpoint();
  const [showNewGuest, setShowNewGuest] = useState(false);
  const [activeTab, setActiveTab] = useState("Tümü");
  const [search, setSearch]       = useState("");
  const { data:repoCustomers, loading:custLoading, error:custError, reload:reloadCusts }
    = useRepo("customer", "getAll");

  const TABS = ["Tümü","Aktif","Rezervasyonu Olanlar","Teklif Bekleyenler","Tekrar Gelenler","Arşiv"];

  const tabMap = {
    "Tümü":                 ()=>true,
    "Aktif":                g=>g.status==="Aktif",
    "Rezervasyonu Olanlar": g=>g.status==="Rezervasyonu Var",
    "Teklif Bekleyenler":   g=>g.status==="Teklif Bekliyor",
    "Tekrar Gelenler":      g=>g.status==="Tekrar Gelen",
    "Arşiv":                g=>g.status==="Arşiv",
  };

  const _rawGuests = (repoCustomers ?? []);
  const allGuests  = _rawGuests.map(c => enrichCustomer(c.id) || c);
  const filtered = allGuests.filter(g => {
    const tabOk  = (tabMap[activeTab]||tabMap["Tümü"])(g);
    const srchOk = !search ||
      g.name.toLowerCase().includes(search.toLowerCase()) ||
      g.country.toLowerCase().includes(search.toLowerCase()) ||
      g.email.toLowerCase().includes(search.toLowerCase()) ||
      g.phone.includes(search);
    return tabOk && srchOk;
  });

  const counts = TABS.reduce((acc,t)=>({...acc,[t]: t==="Tümü"?allGuests.length:allGuests.filter(tabMap[t]||tabMap["Tümü"]).length}),{});

  return (
    <div style={{display:"flex", flexDirection:"column", gap:20}}>

      {}
      <div className="page-header" style={{
        background:C.white, border:`1px solid ${C.border}`, borderRadius:12,
        padding:"20px 24px",
        display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:20,
      }}>
        <div>
          <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:5}}>Misafirler</h1>
          <p style={{margin:0, fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>
            Dese Tour ile iletişime geçmiş tüm misafir profillerini ve geçmişlerini yönetin.
          </p>
        </div>
        <div className="page-header-actions" style={{
          display:"flex", flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center", gap:10, flexShrink:0,
        }}>
          <div style={{position:"relative", width: isMobile ? "100%" : "auto"}}>
            <span style={{position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.textFaint, pointerEvents:"none"}}>
              <GIc d="M21 21l-4.35-4.35 M17 11A6 6 0 105 11a6 6 0 0012 0z" size={14} sw={1.8}/>
            </span>
            <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Misafir adı, ülke, telefon veya email ara…"
              style={{
                paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
                border:`1px solid ${C.border}`, borderRadius:8,
                background:C.ivory, fontSize:13, color:C.text,
                fontFamily:"'DM Sans',sans-serif", outline:"none",
                width: isMobile ? "100%" : 280, boxSizing:"border-box",
                transition:"border-color .15s, box-shadow .15s",
              }}
              onFocus={e=>{ e.target.style.borderColor=C.gold; e.target.style.boxShadow=`0 0 0 3px ${C.gold}20`; }}
              onBlur={e=>{ e.target.style.borderColor=C.border; e.target.style.boxShadow="none"; }}
            />
          </div>
          <button onClick={()=>setShowNewGuest(true)} style={{
            display:"flex", alignItems:"center", justifyContent:"center", gap:7,
            padding:"9px 16px", borderRadius:8, width: isMobile ? "100%" : "auto",
            border:"none", background:C.navy, cursor:"pointer", color:C.white,
            fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:500,
          }}
            onMouseEnter={e=>e.currentTarget.style.background=C.navyHover}
            onMouseLeave={e=>e.currentTarget.style.background=C.navy}
          >
            <GIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
            Yeni Misafir Ekle
          </button>
        </div>
      </div>

      {}
      <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>

        {}
        <div style={{
          display:"flex", alignItems:"center",
          borderBottom:`1px solid ${C.borderLight}`,
          padding:"0 20px", overflowX:"auto",
        }}>
          {TABS.map(tab=>{
            const on=activeTab===tab;
            const cnt=counts[tab]||0;
            return (
              <button key={tab} onClick={()=>setActiveTab(tab)} style={{
                padding:"13px 13px",
                border:"none", borderBottom: on?`2px solid ${C.gold}`:"2px solid transparent",
                background:"transparent",
                color:on?C.gold:C.textMuted,
                fontFamily:"'DM Sans',sans-serif", fontSize:13,
                fontWeight:on?600:400, cursor:"pointer",
                whiteSpace:"nowrap", marginBottom:-1,
                display:"flex", alignItems:"center", gap:5, transition:"color .12s",
              }}>
                {tab}
                {cnt>0 && (
                  <span style={{
                    minWidth:18, height:18, borderRadius:99, padding:"0 5px",
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:10.5, fontWeight:600,
                    background:on?`${C.gold}22`:C.ivoryDark, color:on?C.gold:C.textFaint,
                  }}>{cnt}</span>
                )}
              </button>
            );
          })}
          <div style={{marginLeft:"auto", padding:"0 4px", flexShrink:0}}>
            <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{filtered.length} misafir</span>
          </div>
        </div>

        {}
        {filtered.length===0 ? (
          <div style={{padding:"64px 40px", textAlign:"center"}}>
            <div style={{fontSize:36, opacity:.2, marginBottom:12}}>??</div>
            <div style={{fontSize:15, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6}}>
              Henüz misafir bulunmuyor.
            </div>
            <div style={{fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif"}}>Bu filtre için kayıt yok.</div>
          </div>
        ) : (
          <>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${C.border}`, background:C.ivory}}>
                  {["Misafir","Ülke / Dil","İletişim","Talep","Teklif","Rez.","Harcama","Son İletişim","Durum",""].map((h,i)=>(
                    <th key={i} style={{
                      padding: i===0?"11px 16px 11px 22px":"11px 12px",
                      textAlign:"left", fontSize:10.5, fontWeight:600,
                      color:C.textFaint, fontFamily:"'DM Sans',sans-serif",
                      textTransform:"uppercase", letterSpacing:"0.07em", whiteSpace:"nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((g,i)=>{
                  const isLast=i===filtered.length-1;
                  return (
                    <tr key={g.id}
                      onMouseEnter={()=>setHov(true)}
                      onMouseLeave={()=>setHov(false)}
                      onClick={()=>onSelectGuest&&onSelectGuest(g.id)}
                      style={{background:C.white, cursor:"pointer", transition:"background .1s"}}>
                      {}
                      <td style={{padding:"14px 16px 14px 22px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <div style={{display:"flex", alignItems:"center", gap:10}}>
                          <div style={{
                            width:34, height:34, borderRadius:"50%", flexShrink:0,
                            background:"rgba(27,45,79,0.09)", border:"1.5px solid rgba(27,45,79,0.12)",
                            display:"flex", alignItems:"center", justifyContent:"center",
                          }}>
                            <span style={{fontSize:11, fontWeight:700, color:C.navy, fontFamily:"'DM Sans',sans-serif"}}>{g.initials}</span>
                          </div>
                          <div>
                            <div style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{g.name}</div>
                            <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Mono',monospace", marginTop:1}}>{g.id}</div>
                          </div>
                        </div>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <div style={{fontSize:13.5, color:C.text, fontFamily:"'DM Sans',sans-serif"}}>{g.flag} {g.country}</div>
                        <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{g.language}</div>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <div style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Mono',monospace"}}>{g.phone}</div>
                        <div style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2}}>{g.email}</div>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, textAlign:"center", verticalAlign:"middle"}}>
                        <span style={{fontSize:14, fontWeight:600, color:C.blue, fontFamily:"'Playfair Display',serif"}}>{g.leads}</span>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, textAlign:"center", verticalAlign:"middle"}}>
                        <span style={{fontSize:14, fontWeight:600, color:C.amber, fontFamily:"'Playfair Display',serif"}}>{g.quotes}</span>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, textAlign:"center", verticalAlign:"middle"}}>
                        <span style={{fontSize:14, fontWeight:600, color:g.reservations>0?C.green:C.textFaint, fontFamily:"'Playfair Display',serif"}}>{g.reservations}</span>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <span style={{fontSize:14, fontWeight:700, color:g.totalSpend>0?C.gold:C.textFaint, fontFamily:"'Playfair Display',serif"}}>
                          {g.totalSpend>0?`${g.currency==="TRY"?"₺":"€"}${g.totalSpend.toLocaleString("tr-TR")}`:"—"}
                        </span>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <span style={{fontSize:12.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif"}}>{g.lastContact}</span>
                      </td>
                      {}
                      <td style={{padding:"14px 12px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <GStatusBadge status={g.status} small/>
                      </td>
                      {}
                      <td style={{padding:"14px 16px 14px 8px", borderBottom:isLast?"none":`1px solid ${C.borderLight}`, verticalAlign:"middle"}}>
                        <GIc d="M9 18l6-6-6-6" size={14} sw={1.8} color={C.textFaint}/>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="rsp-cards"><MobileCardList items={filtered} renderCard={(item,i)=>(
                <MobileCard key={item.id} onClick={()=>onSelectGuest&&onSelectGuest(item.id)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontWeight:600,fontSize:14,color:C.text}}>{item.name}</div>
                      <div style={{fontSize:12,color:C.textMuted,marginTop:2}}>{item.country} · {item.email||item.phone||"—"}</div>
                    </div>
                    <span style={{fontSize:11,padding:"3px 8px",borderRadius:99,background:C.ivoryDark,color:C.textMid}}>{item.status||"Aktif"}</span>
                  </div>
                </MobileCard>
              )}/></div>
            <div style={{padding:"11px 20px", background:C.ivory, borderTop:`1px solid ${C.borderLight}`}}>
              <span style={{fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>{filtered.length} / {allGuests.length} misafir · Satıra tıklayarak profili görüntüleyin</span>
            </div>
          </>
        )}
      </div>
      {showNewGuest ? <NewGuestModal onClose={()=>setShowNewGuest(false)}/> : null}
    </div>
  );
}

const MSG_CHANNELS = {
  whatsapp:    { label:"WhatsApp",    color:"#128C7E", bg:"#E7F5F3", icon:"M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413z" },
  email:       { label:"E-posta",     color:"#1A6FAE", bg:"#E8F2FB", icon:"M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6" },
  instagram:   { label:"Instagram",   color:"#C13584", bg:"#FCE8F5", icon:"M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069z M12 6.865a5.135 5.135 0 100 10.27 5.135 5.135 0 000-10.27z M17.338 5.869a1.2 1.2 0 100 2.4 1.2 1.2 0 000-2.4z" },
  facebook:    { label:"Facebook",    color:"#1877F2", bg:"#E8F0FE", icon:"M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z" },
  booking:     { label:"Booking",     color:"#003580", bg:"#E5EAF5", icon:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" },
  tripadvisor: { label:"Tripadvisor", color:"#34E0A1", bg:"#E8FBF5", icon:"M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" },
  telefon:     { label:"Telefon",     color:"#4A5568", bg:"#F0EEF5", icon:"M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.09-1.09a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" },
};

const MOCK_CONVERSATIONS = [
  { id:"CONV-001", customerId:"CUST-001", channel:"whatsapp", subject:"Private Istanbul Experience — Pickup", leadId:"LEAD-001", quoteId:"Q-2026-001", resId:"R-2026-001", unread:2, lastMessage:"Thank you, can you confirm the pickup time and exact location?", lastTime:"14:32", lastDate:"Bugün", status:"open",
    messages:[
      { id:"m1", dir:"in",  text:"Hi! I received your quote for the Private Istanbul Experience.", time:"09:14", date:"04 Haz" },
      { id:"m2", dir:"out", text:"Hello Sarah! The quote includes all entrance fees, private guide and hotel pickup.", time:"09:45", date:"04 Haz" },
      { id:"m3", dir:"in",  text:"Perfect. Can we have a vegetarian lunch option for the tour?", time:"10:12", date:"04 Haz" },
      { id:"m4", dir:"out", text:"Absolutely! We can arrange a vegetarian lunch at a local restaurant. No extra charge.", time:"10:30", date:"04 Haz" },
      { id:"m5", dir:"in",  text:"Wonderful! We would like to confirm the booking.", time:"11:00", date:"04 Haz" },
      { id:"m6", dir:"out", text:"Great! I have sent the confirmation and payment link to your email.", time:"11:15", date:"04 Haz" },
      { id:"m7", dir:"in",  text:"Thank you, can you confirm the pickup time and exact location?", time:"14:32", date:"05 Haz" },
    ],
  },
  { id:"CONV-002", customerId:"CUST-002", channel:"email", subject:"Bosphorus Tour — Group Reservation", leadId:"LEAD-003", quoteId:"Q-2026-002", resId:"R-2026-002", unread:0, lastMessage:"We would like to confirm the Bosphorus & Asian Side Tour for 6 people on June 20.", lastTime:"11:22", lastDate:"Dün", status:"open",
    messages:[
      { id:"m1", dir:"in",  text:"Dear Dese Tour team, we are a group of 6 friends visiting Istanbul from 18–23 June.", time:"09:00", date:"03 Haz" },
      { id:"m2", dir:"out", text:"Dear Emma, thank you for reaching out! I'm attaching our proposal for the Bosphorus tour.", time:"09:30", date:"03 Haz" },
      { id:"m3", dir:"in",  text:"Could you let us know if a private boat is included?", time:"14:00", date:"03 Haz" },
      { id:"m4", dir:"out", text:"Yes, the tour includes a fully private traditional boat for your group.", time:"14:30", date:"03 Haz" },
      { id:"m5", dir:"in",  text:"We would like to confirm the Bosphorus & Asian Side Tour for 6 people on June 20.", time:"11:22", date:"04 Haz" },
    ],
  }
];;

function MsgIc({ d, size=15, sw=1.6, color }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color||"currentColor"} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>;
}

function ChannelBadge({ channel, small }) {
  const m = MSG_CHANNELS[channel] || MSG_CHANNELS.email;
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:small?"2px 7px":"3px 9px",borderRadius:99,fontSize:small?10.5:11.5,fontWeight:500,color:m.color,background:m.bg,fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap",flexShrink:0}}>
      <svg width={small?10:12} height={small?10:12} viewBox="0 0 24 24" fill="none" stroke={m.color} strokeWidth="1.8" strokeLinecap="round"><path d={m.icon}/></svg>
      {m.label}
    </span>
  );
}

function MsgBubble({ msg, customerName }) {
  const isOut  = msg.dir==="out";
  const isNote = msg.dir==="note";
  if (isNote) return (
    <div style={{margin:"10px auto",padding:"9px 14px",maxWidth:"85%",background:"#FFFBEB",border:"1px solid #F5E4A0",borderRadius:8,display:"flex",alignItems:"flex-start",gap:8}}>
      <MsgIc d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2" size={13} sw={1.6} color={C.amber}/>
      <div style={{flex:1}}>
        <div style={{fontSize:12.5,color:C.amber,fontFamily:"'DM Sans',sans-serif",lineHeight:1.5}}>{msg.text}</div>
        <div style={{fontSize:11,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",marginTop:3,textAlign:"right"}}>{msg.date} {msg.time}</div>
      </div>
    </div>
  );
  return (
    <div style={{display:"flex",justifyContent:isOut?"flex-end":"flex-start",marginBottom:10,paddingLeft:isOut?48:0,paddingRight:isOut?0:48}}>
      {!isOut && (
        <div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,background:"rgba(27,45,79,0.09)",marginRight:8,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <span style={{fontSize:10,fontWeight:700,color:C.navy,fontFamily:"'DM Sans',sans-serif"}}>{customerName?.split(" ").map(w=>w[0]).join("").slice(0,2)}</span>
        </div>
      )}
      <div style={{maxWidth:"80%"}}>
        <div style={{padding:"10px 13px",borderRadius:isOut?"12px 12px 2px 12px":"12px 12px 12px 2px",background:isOut?`linear-gradient(135deg,${C.navy} 0%,${C.navyDeep} 100%)`:C.white,border:isOut?"none":`1px solid ${C.border}`,boxShadow:isOut?"0 2px 8px rgba(27,45,79,0.2)":"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{fontSize:13.5,lineHeight:1.55,whiteSpace:"pre-wrap",color:isOut?C.ivory:C.text,fontFamily:"'DM Sans',sans-serif"}}>{msg.text}</div>
        </div>
        <div style={{fontSize:11,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",marginTop:3,textAlign:isOut?"right":"left",paddingLeft:isOut?0:4,paddingRight:isOut?4:0}}>
          {msg.date} {msg.time}{isOut&&<span style={{marginLeft:5,color:C.green}}> ✓✓</span>}
        </div>
      </div>
    </div>
  );
}

function ConvItem({ conv, active, onClick }) {
  const [hov, setHov] = useState(false);
  const cust = getCustomerById(conv.customerId);
  return (
    <div onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} onClick={onClick}
      style={{padding:"13px 16px",borderBottom:`1px solid ${C.borderLight}`,cursor:"pointer",background:active?`rgba(27,45,79,0.06)`:hov?C.ivory:C.white,borderLeft:`3px solid ${active?C.gold:"transparent"}`,transition:"background .1s",position:"relative"}}>
      {conv.unread>0 && <div style={{position:"absolute",top:14,right:14,minWidth:18,height:18,borderRadius:99,padding:"0 5px",background:C.red,color:"#fff",fontSize:10,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans',sans-serif"}}>{conv.unread}</div>}
      <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:6}}>
        <div style={{width:36,height:36,borderRadius:"50%",flexShrink:0,background:active?"rgba(27,45,79,0.15)":"rgba(27,45,79,0.08)",display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
          <span style={{fontSize:12,fontWeight:700,color:active?C.navy:C.textMid,fontFamily:"'DM Sans',sans-serif"}}>{cust?cust.name.split(" ").map(w=>w[0]).join("").slice(0,2):"?"}</span>
          <div style={{position:"absolute",bottom:-2,right:-2,width:14,height:14,borderRadius:"50%",background:MSG_CHANNELS[conv.channel]?.color||C.textFaint,border:`1.5px solid ${C.white}`}}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13.5,fontWeight:conv.unread>0?700:500,color:C.text,fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{cust?.name||"Bilinmiyor"}</div>
          <div style={{fontSize:11.5,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{conv.subject}</div>
        </div>
        <div style={{fontSize:11,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",flexShrink:0,marginTop:2}}>{conv.lastTime}</div>
      </div>
      <div style={{fontSize:12.5,color:conv.unread>0?C.textMid:C.textFaint,fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",paddingLeft:46,fontWeight:conv.unread>0?500:400}}>{conv.lastMessage}</div>
    </div>
  );
}

function ConvDetail({ conv }) {
  const cust = getCustomerById(conv.customerId);
  const lead = conv.leadId ? getLeadById(conv.leadId) : null;
  const res  = conv.resId  ? getReservationById(conv.resId)  : null;
  const ch   = MSG_CHANNELS[conv.channel] || MSG_CHANNELS.email;
  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      <div style={{padding:"14px 20px",borderBottom:`1px solid ${C.border}`,background:C.white,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:42,height:42,borderRadius:"50%",flexShrink:0,background:"rgba(27,45,79,0.09)",border:"1.5px solid rgba(27,45,79,0.12)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{fontSize:14,fontWeight:700,color:C.navy,fontFamily:"'Playfair Display',serif"}}>{cust?.name.split(" ").map(w=>w[0]).join("").slice(0,2)||"?"}</span>
          </div>
          <div>
            <div style={{fontSize:15,fontWeight:600,color:C.text,fontFamily:"'Playfair Display',serif"}}>{cust?.name||"Bilinmiyor"}</div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:3,flexWrap:"wrap"}}>
              <ChannelBadge channel={conv.channel} small/>
              {cust?.country&&<span style={{fontSize:11.5,color:C.textFaint,fontFamily:"'DM Sans',sans-serif"}}>{cust.flag} {cust.country}</span>}
              {lead&&<IDLink id={lead.id} type="lead"/>}
              {res&&<IDLink id={res.id} type="reservation"/>}
            </div>
          </div>
        </div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"16px 20px",background:C.ivory,display:"flex",flexDirection:"column"}}>
        {conv.messages.length>0&&<div style={{textAlign:"center",marginBottom:16,fontSize:11.5,color:C.textFaint,fontFamily:"'DM Sans',sans-serif"}}><span style={{background:C.ivoryDark,padding:"3px 12px",borderRadius:99,border:`1px solid ${C.border}`}}>{conv.messages[0].date}</span></div>}
        {conv.messages.map(msg=><MsgBubble key={msg.id} msg={msg} customerName={cust?.name}/>)}
      </div>
      <div style={{padding:"12px 16px",borderTop:`1px solid ${C.border}`,background:C.white,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:C.ivoryDark,borderRadius:10,border:`1px solid ${C.border}`,cursor:"not-allowed",opacity:0.7}}>
          <MsgIc d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" size={16} sw={1.6} color={C.textFaint}/>
          <span style={{flex:1,fontSize:13,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",fontStyle:"italic"}}>{ch.label} entegrasyonu sonrası yanıt aktif olacak…</span>
          <div style={{fontSize:11,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",background:C.border,padding:"3px 9px",borderRadius:99}}>V2</div>
        </div>
      </div>
    </div>
  );
}

function ConvContext({ conv }) {
  const cust  = getCustomerById(conv.customerId);
  const lead  = conv.leadId ? getLeadById(conv.leadId)          : null;
  const quote = conv.quoteId ? getQuoteById(conv.quoteId)       : null;
  const res   = conv.resId  ? getReservationById(conv.resId)   : null;
  const ACTIONS = [
    { label:"Misafir Profilini Aç", icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2",  to:"/customers/"+(cust?.id||"") },
    { label:"Talebi Aç",            icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01",  to:lead?"/leads/"+lead.id:null },
    { label:"Teklif Oluştur",       icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6", to:"/quotes/new" },
    { label:"Rezervasyonu Aç",      icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", to:res?"/reservations/"+res.id:null },
    { label:"Görev Oluştur",        icon:"M9 11l3 3L22 4",                              to:"/tasks" },
    { label:"Hatırlatma Oluştur",   icon:"M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0", to:"/reminders" },
  ];
  function InfoRow({ label, val, link }) {
    return (
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${C.borderLight}`}}>
        <span style={{fontSize:12,color:C.textFaint,fontFamily:"'DM Sans',sans-serif"}}>{label}</span>
        {link?<IDLink id={val} type={link}/>:<span style={{fontSize:12.5,color:C.text,fontFamily:"'DM Sans',sans-serif",fontWeight:500}}>{val||"—"}</span>}
      </div>
    );
  }
  return (
    <div style={{background:C.white,borderLeft:`1px solid ${C.border}`,height:"100%",overflowY:"auto",display:"flex",flexDirection:"column"}}>
      {cust&&(
        <div style={{padding:"16px",background:`linear-gradient(135deg,${C.navyDeep} 0%,${C.navy} 100%)`,flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{width:38,height:38,borderRadius:"50%",background:"rgba(201,168,76,0.2)",border:"1.5px solid rgba(201,168,76,0.35)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <span style={{fontSize:13,fontWeight:700,color:C.goldLight,fontFamily:"'Playfair Display',serif"}}>{cust.name.split(" ").map(w=>w[0]).join("").slice(0,2)}</span>
            </div>
            <div>
              <div style={{fontSize:14,fontWeight:600,color:C.ivory,fontFamily:"'Playfair Display',serif",lineHeight:1.2}}>{cust.name}</div>
              <div style={{fontSize:11.5,color:"rgba(248,245,238,0.55)",fontFamily:"'DM Sans',sans-serif",marginTop:2}}>{cust.flag} {cust.country} · {cust.language}</div>
            </div>
          </div>
          {cust.phone&&<div style={{fontSize:11,color:"rgba(248,245,238,0.7)",fontFamily:"'DM Mono',monospace",background:"rgba(255,255,255,0.07)",padding:"4px 8px",borderRadius:5,marginBottom:4}}>{cust.phone}</div>}
        </div>
      )}
      <div style={{padding:"14px 16px",flex:1,overflowY:"auto"}}>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10.5,fontWeight:600,color:C.textFaint,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:"'DM Sans',sans-serif",marginBottom:8}}>Hızlı İşlemler</div>
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            {ACTIONS.map((a,i)=>(
              <a key={i} href={a.to?"#"+a.to:undefined} onClick={a.to?(e)=>{e.preventDefault();if(ROUTER_STATE.setPath)ROUTER_STATE.setPath(a.to);else if(NAV_REF.fn)NAV_REF.fn(a.to);}:e=>e.preventDefault()} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:7,border:`1px solid ${a.to?C.border:C.borderLight}`,background:a.to?C.white:C.ivoryDark,color:a.to?C.text:C.textFaint,textDecoration:"none",cursor:a.to?"pointer":"not-allowed",fontSize:12.5,fontFamily:"'DM Sans',sans-serif",opacity:a.to?1:0.5}}
                onMouseEnter={e=>{if(a.to)e.currentTarget.style.background=C.ivory;}}
                onMouseLeave={e=>{if(a.to)e.currentTarget.style.background=C.white;}}>
                <MsgIc d={a.icon} size={13} sw={1.6}/>{a.label}
              </a>
            ))}
          </div>
        </div>
        {lead&&<div style={{marginBottom:14}}><div style={{fontSize:10.5,fontWeight:600,color:C.textFaint,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:"'DM Sans',sans-serif",marginBottom:8}}>İlgili Talep</div><InfoRow label="Talep No" val={lead.id} link="lead"/><InfoRow label="Tur" val={lead.tour}/><InfoRow label="Durum" val={lead.status}/></div>}
        {res&&<div style={{marginBottom:14}}><div style={{fontSize:10.5,fontWeight:600,color:C.textFaint,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:"'DM Sans',sans-serif",marginBottom:8}}>Rezervasyon</div><InfoRow label="Rez. No" val={res.id} link="reservation"/><InfoRow label="Tarih" val={res.date}/><InfoRow label="Durum" val={res.opStatus}/></div>}
        {!lead&&!quote&&!res&&<div style={{padding:"14px",borderRadius:8,background:C.ivory,border:`1px solid ${C.borderLight}`,textAlign:"center"}}><div style={{fontSize:12.5,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",marginTop:6}}>Bu konuşmaya bağlı kayıt yok.</div></div>}
      </div>
    </div>
  );
}

function MessagesPage() {
  const { isMobile } = useBreakpoint();
  const [activeFilter, setActiveFilter] = useState("Tümü");
  const [selectedId, setSelectedId]     = useState("CONV-001");
  const [mobileView, setMobileView]     = useState("list");

  const FILTERS = [
    { key:"Tümü",      count:MOCK_CONVERSATIONS.length },
    { key:"Okunmamış", count:MOCK_CONVERSATIONS.filter(c=>c.unread>0).length },
    { key:"WhatsApp",  count:MOCK_CONVERSATIONS.filter(c=>c.channel==="whatsapp").length },
    { key:"E-posta",   count:MOCK_CONVERSATIONS.filter(c=>c.channel==="email").length },
    { key:"Booking",   count:MOCK_CONVERSATIONS.filter(c=>c.channel==="booking").length },
    { key:"Telefon",   count:MOCK_CONVERSATIONS.filter(c=>c.channel==="telefon").length },
  ];

  const filtered = MOCK_CONVERSATIONS.filter(c=>{
    if(activeFilter==="Tümü")return true;
    if(activeFilter==="Okunmamış")return c.unread>0;
    const label=MSG_CHANNELS[c.channel]?.label;
    return label===activeFilter||c.channel===activeFilter.toLowerCase();
  });

  const selectedConv = MOCK_CONVERSATIONS.find(c=>c.id===selectedId);
  const totalUnread  = MOCK_CONVERSATIONS.reduce((s,c)=>s+c.unread,0);

  function selectConv(id) {
    setSelectedId(id);
    if(isMobile)setMobileView("detail");
    const c=MOCK_CONVERSATIONS.find(x=>x.id===id);
    if(c)c.unread=0;
  }

  const ListPanel = (
    <div style={{display:"flex",flexDirection:"column",background:C.white,borderRight:`1px solid ${C.border}`,height:"100%",overflow:"hidden"}}>
      <div style={{padding:"14px 16px",borderBottom:`1px solid ${C.border}`,flexShrink:0,background:C.ivory}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div>
            <div style={{fontSize:15,fontWeight:600,color:C.text,fontFamily:"'Playfair Display',serif"}}>Mesajlar</div>
            {totalUnread>0&&<div style={{fontSize:11.5,color:C.red,fontFamily:"'DM Sans',sans-serif",marginTop:2}}>{totalUnread} okunmamış mesaj</div>}
          </div>
        </div>
        <div style={{position:"relative"}}>
          <input placeholder="Konuşma ara…" style={{width:"100%",boxSizing:"border-box",padding:"7px 10px 7px 30px",border:`1px solid ${C.border}`,borderRadius:7,background:C.white,fontSize:13,color:C.text,fontFamily:"'DM Sans',sans-serif",outline:"none"}}/>
          <span style={{position:"absolute",left:9,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}}>
            <MsgIc d="M21 21l-4.35-4.35 M17 11A6 6 0 105 11a6 6 0 0012 0z" size={13} sw={1.7} color={C.textFaint}/>
          </span>
        </div>
      </div>
      <div style={{display:"flex",gap:0,overflowX:"auto",flexShrink:0,borderBottom:`1px solid ${C.borderLight}`,scrollbarWidth:"none"}}>
        {FILTERS.filter(f=>f.count>0||f.key==="Tümü").map(f=>{
          const on=activeFilter===f.key;
          return <button key={f.key} onClick={()=>setActiveFilter(f.key)} style={{padding:"9px 12px",border:"none",cursor:"pointer",borderBottom:on?`2px solid ${C.gold}`:"2px solid transparent",background:"transparent",color:on?C.gold:C.textMuted,fontFamily:"'DM Sans',sans-serif",fontSize:12.5,fontWeight:on?600:400,whiteSpace:"nowrap",marginBottom:-1,flexShrink:0}}>{f.key}</button>;
        })}
      </div>
      <div style={{flex:1,overflowY:"auto"}}>
        {filtered.length===0?(
          <div style={{padding:"40px 20px",textAlign:"center"}}>
            <div style={{fontSize:13.5,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",marginTop:10}}>Konuşma bulunamadı</div>
          </div>
        ):filtered.map(conv=><ConvItem key={conv.id} conv={conv} active={conv.id===selectedId} onClick={()=>selectConv(conv.id)}/>)}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 52px)",overflow:"hidden"}}>
        {mobileView==="list"?(
          <div style={{height:"100%",overflow:"hidden"}}>{ListPanel}</div>
        ):(
          <div style={{height:"100%",display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <button onClick={()=>setMobileView("list")} style={{display:"flex",alignItems:"center",gap:6,padding:"10px 16px",background:C.ivory,border:"none",borderBottom:`1px solid ${C.border}`,cursor:"pointer",color:C.textMid,fontFamily:"'DM Sans',sans-serif",fontSize:13,flexShrink:0}}>
              <MsgIc d="M15 18l-6-6 6-6" size={13} sw={2}/> Konuşma Listesi
            </button>
            {selectedConv?<div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}><ConvDetail conv={selectedConv}/></div>:<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{color:C.textFaint,fontFamily:"'DM Sans',sans-serif"}}>Konuşma seçin</div></div>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",height:"calc(100vh - 80px)",display:"grid",gridTemplateColumns:"280px 1fr 260px"}}>
      {ListPanel}
      <div style={{height:"100%",overflow:"hidden",display:"flex",flexDirection:"column"}}>
        {selectedConv?<ConvDetail conv={selectedConv}/>:(
          <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,background:C.ivory}}>
            <div style={{width:64,height:64,borderRadius:"50%",background:"rgba(27,45,79,0.07)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <MsgIc d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" size={28} sw={1.3} color={C.textMuted}/>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:16,fontWeight:600,color:C.text,fontFamily:"'Playfair Display',serif",marginBottom:6}}>Konuşma seçin</div>
              <div style={{fontSize:13,color:C.textFaint,fontFamily:"'DM Sans',sans-serif"}}>Sol listeden bir konuşmaya tıklayın</div>
            </div>
          </div>
        )}
      </div>
      <div style={{height:"100%",overflow:"hidden"}}>
        {selectedConv?<ConvContext conv={selectedConv}/>:(
          <div style={{height:"100%",background:C.ivory,borderLeft:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{fontSize:12.5,color:C.textFaint,fontFamily:"'DM Sans',sans-serif",textAlign:"center",padding:"0 20px"}}>Müşteri bilgileri burada görünecek</div>
          </div>
        )}
      </div>
    </div>
  );
}

function NewGuestModal({ onClose }) {
  const { isMobile } = useBreakpoint();
  const { getSourceId, sourceOptions } = useSources();
  const [name,setName]=useState(""); const [phone,setPhone]=useState(""); const [email,setEmail]=useState("");
  const [country,setCountry]=useState("Avustralya"); const [lang,setLang]=useState("İngilizce");
  const [source,setSource]=useState("Website");
  const [notes,setNotes]=useState(""); const [errs,setErrs]=useState({});
  const { mutate:mutCustG, mutating:guestMut } = useRepoMutation("customer");

  async function handleSubmit() {
    const e = validate({name:{required:"Ad Soyad zorunludur"},email:{email:"Geçerli e-posta girin"}},{name,email});
    setErrs(e); if (Object.keys(e).length) return;
    const resolvedSourceId = getSourceId(source);
    const { error } = await mutCustG("create", {
      name, phone:phone||"", email:email||"",
      initials:name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(),
      flag:"🌍", country, language:lang, sourceId:resolvedSourceId, notes,
    });
    if (error) {
      console.error('[NewGuestModal] customer create failed:', error);
      showToast("Misafir kaydedilemedi: " + error);
      return;
    }
    showToast("Misafir oluşturuldu ✓"); onClose();
  }
  return (
    <FormShell isMobile={isMobile} title="Yeni Misafir Ekle" onClose={onClose} onSubmit={handleSubmit}
      submitLabel="Misafiri Kaydet" submitting={guestMut}>
      <FGrid>
        <FRow label="Ad Soyad" required error={errs.name}><FText value={name} onChange={setName} placeholder="Sarah Johnson"/></FRow>
        <FRow label="Telefon"><FText value={phone} onChange={setPhone} placeholder="+90 555 000 0000" mono/></FRow>
        <FRow label="E-posta" error={errs.email}><FText value={email} onChange={setEmail} placeholder="email@example.com" type="email"/></FRow>
        <FRow label="Ülke"><FSelect value={country} onChange={setCountry} options={["Avustralya","ABD","İngiltere","Almanya","Japonya","İtalya","Fransa","Türkiye","Diğer"]}/></FRow>
        <FRow label="Dil"><FSelect value={lang} onChange={setLang} options={["İngilizce","Türkçe","Almanca","Fransızca","İtalyanca","Japonca","Diğer"]}/></FRow>
        <FRow label="Kaynak"><FSelect value={source} onChange={setSource} options={sourceOptions}/></FRow>
      </FGrid>
      <FRow label="Notlar"><FTextArea value={notes} onChange={setNotes} placeholder="Misafir hakkında notlar…"/></FRow>
    </FormShell>
  );
}

function NewTaskModal({ onClose, prefillCustomerId, prefillLeadId, prefillResId }) {
  const [title,setTitle]=useState("");
  const [category,setCategory]=useState("Operasyon");
  const [priority,setPriority]=useState("Orta");
  const [dueDate,setDueDate]=useState("");
  const [custId,setCustId]=useState(prefillCustomerId||"");
  const [assignee,setAssignee]=useState(DB.staff[0]?.id||"STAFF-001");
  const [notes,setNotes]=useState("");
  const [errs,setErrs]=useState({});
  const { mutate:mutTask, mutating:taskMut } = useRepoMutation("task");

  async function handleSubmit() {
    const e = validate({ title:{ required:"Görev başlığı zorunludur" } }, { title });
    setErrs(e); if (Object.keys(e).length) return;
    const { error:te } = await mutTask("create", {
      title, customerId:custId||null,
      leadId:prefillLeadId||null, resId:prefillResId||null,
      category, priority, dueDate:dueDate||"—", assigneeId:assignee, notes,
    });
    if (te) { showToast("Görev oluşturulamadı ✗"); return; }
    showToast("Görev oluşturuldu ✓"); onClose();
  }
  return (
    <Modal title="Yeni Görev Ekle" onClose={onClose} onSubmit={handleSubmit}
      submitLabel={taskMut?"Kaydediliyor…":"Görevi Kaydet"}>
      <FRow label="Görev Başlığı" required error={errs.title}>
        <FText value={title} onChange={setTitle} placeholder="Görevi kısaca açıklayın…"/>
      </FRow>
      <FGrid>
        <FRow label="Kategori">
          <FSelect value={category} onChange={setCategory}
            options={["Operasyon","Ödeme","Rehber","Ulaşım","Müşteri","Teklif","Genel"]}/>
        </FRow>
        <FRow label="Öncelik">
          <FSelect value={priority} onChange={setPriority}
            options={["Düşük","Orta","Yüksek","Acil"]}/>
        </FRow>
        <FRow label="Son Tarih">
          <FText value={dueDate} onChange={setDueDate} placeholder="22 Haz 2026"/>
        </FRow>
        <FRow label="Sorumlu">
          <FSelect value={assignee} onChange={setAssignee}
            options={DB.staff.map(s=>[s.id,s.name])}/>
        </FRow>
      </FGrid>
      <FRow label="İlgili Müşteri">
        <FSelect value={custId} onChange={setCustId}
          options={[["","— Seçin —"], ...DB.customers.map(c=>[c.id,c.name])]}/>
      </FRow>
      <FRow label="Notlar">
        <FTextArea value={notes} onChange={setNotes} placeholder="Ek notlar…"/>
      </FRow>
    </Modal>
  );
}

function NewReminderModal({ onClose }) {
  const [title,setTitle]=useState("");
  const [type,setType]=useState("Ödeme Takibi");
  const [priority,setPriority]=useState("Orta");
  const [dueDate,setDueDate]=useState("");
  const [custId,setCustId]=useState("");
  const [assignee,setAssignee]=useState(DB.staff[0]?.id||"STAFF-001");
  const [notes,setNotes]=useState("");
  const [errs,setErrs]=useState({});
  const { mutate:mutRem, mutating:remMut } = useRepoMutation("reminder");

  async function handleSubmit() {
    const e = validate({ title:{ required:"Başlık zorunludur" } }, { title });
    setErrs(e); if (Object.keys(e).length) return;
    const { error:re } = await mutRem("create", {
      title, customerId:custId||null, leadId:null, resId:null,
      type, priority, dueDate:dueDate||"—", assigneeId:assignee, notes,
    });
    if (re) { showToast("Hatırlatma oluşturulamadı ✗"); return; }
    showToast("Hatırlatma oluşturuldu ✓"); onClose();
  }
  return (
    <Modal title="Yeni Hatırlatma" onClose={onClose} onSubmit={handleSubmit}
      submitLabel={remMut?"Kaydediliyor…":"Hatırlatmayı Kaydet"}>
      <FRow label="Başlık" required error={errs.title}>
        <FText value={title} onChange={setTitle} placeholder="Hatırlatma başlığı…"/>
      </FRow>
      <FGrid>
        <FRow label="Tür">
          <FSelect value={type} onChange={setType}
            options={["Ödeme Takibi","Tur Hatırlatma","Rehber Ataması","Müşteri Takibi","Genel","Operasyon Notu"]}/>
        </FRow>
        <FRow label="Öncelik">
          <FSelect value={priority} onChange={setPriority}
            options={["Düşük","Orta","Yüksek","Acil"]}/>
        </FRow>
        <FRow label="Tarih / Saat">
          <FText value={dueDate} onChange={setDueDate} placeholder="22 Haz 2026 09:00"/>
        </FRow>
        <FRow label="Sorumlu">
          <FSelect value={assignee} onChange={setAssignee}
            options={DB.staff.map(s=>[s.id,s.name])}/>
        </FRow>
      </FGrid>
      <FRow label="İlgili Müşteri">
        <FSelect value={custId} onChange={setCustId}
          options={[["","— Seçin —"], ...DB.customers.map(c=>[c.id,c.name])]}/>
      </FRow>
      <FRow label="Notlar">
        <FTextArea value={notes} onChange={setNotes} placeholder="Ek notlar…"/>
      </FRow>
    </Modal>
  );
}

function NewPaymentModal({ onClose }) {
  const { isMobile } = useBreakpoint();
  const [custId,setCustId]=useState(DB.customers[0]?.id||"");
  const [resId,setResId]=useState("");
  const [amount,setAmount]=useState("");
  const [currency,setCurrency]=useState("EUR");
  const [payType,setPayType]=useState("Kapora");
  const [method,setMethod]=useState("Banka Transferi");
  const [notes,setNotes]=useState("");
  const [errs,setErrs]=useState({});
  const custRes = DB.reservations.filter(r=>!custId||r.customerId===custId);
  const { mutate:mutPay, mutating:payMut } = useRepoMutation("payment");

  async function handleSubmit() {
    const e = validate({amount:{required:"Tutar zorunludur",number:"Sayısal değer girin"}},{amount});
    setErrs(e); if (Object.keys(e).length) return;
    const amt = parseFloat(amount);
    const { error:pe } = await mutPay("create", {
      resId:resId||null, customerId:custId||null,
      amount:amt, currency, paymentType:payType, method, notes,
    });
    if (pe) { showToast("Ödeme kaydedilemedi ✗"); return; }
    showToast("Ödeme kaydedildi ✓"); onClose();
  }
  return (
    <FormShell isMobile={isMobile} title="Ödeme Kaydı Ekle" onClose={onClose} onSubmit={handleSubmit}
      submitLabel="Ödemeyi Kaydet" submitting={payMut}>
      <FRow label="Müşteri">
        <FSelect value={custId} onChange={v=>{setCustId(v);setResId("");}}
          options={DB.customers.map(c=>[c.id,c.name])}/>
      </FRow>
      <FRow label="Rezervasyon">
        <FSelect value={resId} onChange={setResId}
          options={[["","— Rezervasyon Seçin —"],...custRes.map(r=>[r.id,`${r.tour} (${r.date})`])]}/>
      </FRow>
      <FGrid>
        <FRow label="Tutar" required error={errs.amount}>
          <FText value={amount} onChange={setAmount} placeholder="0.00" mono/>
        </FRow>
        <FRow label="Para Birimi">
          <FSelect value={currency} onChange={setCurrency} options={["EUR","USD","GBP","TRY"]}/>
        </FRow>
        <FRow label="Ödeme Türü">
          <FSelect value={payType} onChange={setPayType}
            options={["Kapora","Kalan Ödeme","Tam Ödeme","İade","Ek Ödeme"]}/>
        </FRow>
        <FRow label="Yöntem">
          <FSelect value={method} onChange={setMethod}
            options={["Banka Transferi","Kredi Kartı","Nakit","Wise","PayPal","Diğer"]}/>
        </FRow>
      </FGrid>
      <FRow label="Notlar">
        <FTextArea value={notes} onChange={setNotes} placeholder="Referans numarası, not…"/>
      </FRow>
    </FormShell>
  );
}

const AppConfig = (() => {
  const env = (typeof window !== 'undefined' && window.__DESE_CONFIG) || {};
  const url = env.VITE_SUPABASE_URL  || '';
  const key = env.VITE_SUPABASE_ANON_KEY || '';
  const useSupabase = !!(url && key && url.startsWith('https://') &&
    !url.includes('YOUR_PROJECT') && !key.includes('YOUR_ANON_KEY'));
  const emailEndpoint = env.EMAIL_ENDPOINT || '/api/send-email';
  const fromEmail     = env.FROM_EMAIL     || 'hello@desetour.com';
  const fromName      = env.FROM_NAME      || 'Dese Tour';
  const useResend     = !!(env.USE_RESEND === 'true' || env.USE_RESEND === true);

  return {
    useSupabase, supabaseUrl:url, supabaseKey:key,
    dataSource:    useSupabase ? 'Supabase' : 'Mock',
    emailEndpoint, fromEmail, fromName, useResend,
  };
})();

let _sb = null;
function getSB() {
  if (_sb) return _sb;
  if (!AppConfig.useSupabase) return null;
  try {
    const factory = (window.__supabase || {}).createClient;
    if (!factory) return null;
    _sb = factory(AppConfig.supabaseUrl, AppConfig.supabaseKey, {
      auth: { persistSession:true, autoRefreshToken:true },
      global: { headers: { 'x-app-name':'dese-tour-ops' } },
    });
    return _sb;
  } catch(e) { console.warn('[DeseTour]', e.message); return null; }
}

async function _sbLog(type, id, action, desc) {
  const sb = getSB(); if (!sb || !id) return;
  try {
    let uid = (typeof _authCache !== 'undefined' && _authCache?.session?.user?.id) || null;
    if (!uid) {
      const { data } = await sb.auth.getSession();
      uid = data?.session?.user?.id || null;
    }
    const { error } = await sb.from('activity_logs')
      .insert({ entity_type:type, entity_id:id, action, description:desc, performed_by:uid });
    if (error) console.error('[_sbLog] activity_logs insert failed:', error.message, { type, id, action });
  } catch(e) {
    console.error('[_sbLog] unexpected error:', e);
  }
}

function mapCustomerFromDB(r) {
  if (!r) return null;
  return { id:r.id, name:r.full_name||'', email:r.email||'', phone:r.phone||'',
    country:r.nationality||'', language:r.language||'İngilizce', notes:r.notes||'',
    tags:r.tags||[], status:r.is_active===false?'Arşiv':'Aktif',
    initials:(r.full_name||'?').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase(),
    flag:'🌍', sourceId:r.source_id||null,
    firstContact:r.created_at?new Date(r.created_at).toLocaleDateString('tr-TR',{day:'2-digit',month:'short',year:'numeric'}):'—',
    lastContact:r.updated_at?new Date(r.updated_at).toLocaleDateString('tr-TR',{day:'2-digit',month:'short',year:'numeric'}):'—',
    importType:r.import_type||'manual', _fromDB:true };
}
function mapCustomerToDB(d) {
  const r={};
  if(d.name!=null)r.full_name=d.name; if(d.full_name!=null)r.full_name=d.full_name;
  if(d.email!=null)r.email=d.email||null; if(d.phone!=null)r.phone=d.phone||null;
  if(d.country!=null)r.nationality=d.country; if(d.nationality!=null)r.nationality=d.nationality;
  if(d.language!=null)r.language=d.language; if(d.notes!=null)r.notes=d.notes;
  if(d.tags!=null)r.tags=d.tags; if(d.sourceId!=null)r.source_id=d.sourceId;
  if(d.source_id!=null)r.source_id=d.source_id; if(d.importType!=null)r.import_type=d.importType;
  return r;
}
const _S2A={'new':'Yeni','contacted':'Görüşüldü','quote_sent':'Teklif Gönderildi','quote_approved':'Teklif Onaylandı','won':'Onaylandı','lost':'İptal','on_hold':'Beklemede'};
const _A2S={'Yeni':'new','Görüşüldü':'contacted','Teklif Hazırlanıyor':'contacted','Teklif Gönderildi':'quote_sent','Teklif Onaylandı':'quote_approved','Ödeme Bekleniyor':'quote_approved','Onaylandı':'won','İptal':'lost','Beklemede':'on_hold'};
function _tAgo(d){const m=Math.floor((Date.now()-d)/60000);if(m<60)return m+'dk önce';const h=Math.floor(m/60);if(h<24)return h+'sa önce';const dy=Math.floor(h/24);if(dy<7)return dy+'g önce';return d.toLocaleDateString('tr-TR',{day:'2-digit',month:'short'});}
function mapLeadFromDB(r) {
  if(!r)return null; const c=r.customer;
  return { id:r.id, leadNumber:r.lead_number||r.id, customerId:r.customer_id||null,
    name:c?.full_name||r.contact_name||'—', phone:c?.phone||r.contact_phone||'',
    email:c?.email||r.contact_email||'', tour:r.destination||'',
    dateRange:r.travel_start_date?new Date(r.travel_start_date).toLocaleDateString('tr-TR',{day:'2-digit',month:'long',year:'numeric'}):'',
    travelStart:r.travel_start_date||'', paxAdult:r.pax_adult||1, paxChild:r.pax_child||0,
    status:_S2A[r.status]||r.status||'Yeni', sourceId:r.source_id||null,
    assigneeId:r.assigned_to||null, currency:r.currency||'EUR', notes:r.notes||'',
    importType:r.import_type||'manual',
    ago:r.created_at?_tAgo(new Date(r.created_at)):'—',
    createdAt:r.created_at?r.created_at.split('T')[0]:'', budget:r.budget||0, _fromDB:true };
}
const _RES_S_DB={'Hazırlanıyor':'pending_confirmation','Onaylandı':'confirmed','Rehber Atandı':'confirmed','Tur Günü':'in_progress','Tamamlandı':'completed','İptal':'cancelled'};
const _RES_S_APP={'pending_confirmation':'Hazırlanıyor','confirmed':'Onaylandı','in_progress':'Tur Günü','completed':'Tamamlandı','cancelled':'İptal'};
const _PAY_S_DB={'Bekliyor':'pending','Kapora Ödendi':'deposit_paid','Kısmi Ödendi':'partial','Ödendi':'paid','Gecikmiş':'overdue','İade Edildi':'refunded'};
const _PAY_S_APP={'pending':'Bekliyor','deposit_paid':'Kapora Ödendi','partial':'Kısmi Ödendi','paid':'Ödendi','overdue':'Gecikmiş','refunded':'İade Edildi'};
const _r2DB=v=>_RES_S_DB[v]||v||'pending_confirmation';
const _r2App=v=>_RES_S_APP[v]||v||'Hazırlanıyor';
const _p2DB=v=>_PAY_S_DB[v]||v||'pending';
const _p2App=v=>_PAY_S_APP[v]||v||'Bekliyor';
const _mToDB=m=>{const mp={'Banka Transferi':'bank_transfer','Kredi Kartı':'credit_card','Nakit':'cash','Wise':'wise','PayPal':'paypal','Diğer':'other'};return mp[m]||(m||'').toLowerCase().replace(' ','_')||null;};
const _mFromDB=m=>{const mp={'bank_transfer':'Banka Transferi','credit_card':'Kredi Kartı','cash':'Nakit','wise':'Wise','paypal':'PayPal','other':'Diğer'};return mp[m]||m||'—';};
function mapResFromDB(r) {
  if(!r)return null; const c=r.customer;
  return { id:r.id, resNumber:r.reservation_number||r.id, leadId:r.lead_id||null,
    quoteId:r.quote_id||null, customerId:r.customer_id||null, tourId:r.tour_id||null,
    name:c?.full_name||'', tour:r.destination||r.tour?.name||'',
    date:r.check_in?new Date(r.check_in).toLocaleDateString('tr-TR',{day:'2-digit',month:'short',year:'numeric'}):'—',
    checkIn:r.check_in||null, checkOut:r.check_out||null, time:r.check_in_time||'09:00',
    pax:r.pax_adult||1, paxChild:r.pax_child||0,
    guide:r.guide_name||'', vehicle:r.vehicle_info||'', driver:r.driver_name||'',
    pickup:r.pickup_location||'', pickupTime:r.pickup_time||'—',
    opStatus:_r2App(r.status), payStatus:_p2App(r.payment_status),
    total:parseFloat(r.total_amount)||0, deposit:parseFloat(r.deposit_amount)||0,
    remaining:parseFloat(r.total_amount||0)-parseFloat(r.deposit_amount||0),
    currency:r.currency||'EUR', opNotes:r.notes||'', assigneeId:r.assigned_to||null,
    createdAt:r.created_at?r.created_at.split('T')[0]:'', _fromDB:true };
}
function mapPayFromDB(r) {
  if(!r)return null;
  const tm={deposit:'Kapora',balance:'Kalan Ödeme',full:'Tam Ödeme',refund:'İade',extra:'Ek Ödeme'};
  // Whole days from today to due_date (negative = overdue) — same convention
  // PaySidebar/mock payment records use, so real Supabase payments group
  // into "Geciken"/"Yaklaşan" correctly instead of always landing empty.
  const dueDateRaw = r.due_date
    ? Math.round((new Date(r.due_date+'T00:00:00') - new Date(new Date().toDateString())) / 86400000)
    : 9999;
  return { id:r.id, payNumber:r.payment_number||r.id, resId:r.reservation_id||null,
    customerId:r.customer_id||null, paymentType:tm[r.payment_type]||r.payment_type||'Kapora',
    amount:parseFloat(r.amount)||0, currency:r.currency||'EUR', status:_p2App(r.status),
    method:_mFromDB(r.method), dueDate:r.due_date||'', dueDateRaw,
    depositDate:r.paid_at?new Date(r.paid_at).toLocaleDateString('tr-TR',{day:'2-digit',month:'short',year:'numeric'}):'—',
    notes:r.notes||'', createdAt:r.created_at?r.created_at.split('T')[0]:'',
    customerName:r.customer?.full_name||'', resRef:r.reservation?.reservation_number||r.reservation_id||'',
    _fromDB:true };
}
const _TP_DB={'Düşük':'low','Orta':'medium','Yüksek':'high','Acil':'urgent'};
const _TP_APP={'low':'Düşük','medium':'Orta','high':'Yüksek','urgent':'Acil'};
const _TS_DB={'Açık':'todo','Devam Ediyor':'in_progress','Tamamlandı':'done','İptal':'cancelled'};
const _TS_APP={'todo':'Açık','in_progress':'Devam Ediyor','done':'Tamamlandı','cancelled':'İptal'};
function mapTaskFromDB(r) {
  if(!r)return null;
  return { id:r.id, title:r.title||'', description:r.description||'',
    status:_TS_APP[r.status]||r.status||'Açık', priority:_TP_APP[r.priority]||r.priority||'Orta',
    category:r.category||'', assigneeId:r.assigned_to||null, customerId:r.customer_id||null,
    leadId:r.lead_id||null, resId:r.reservation_id||null,
    dueDate:r.due_date?new Date(r.due_date).toLocaleDateString('tr-TR',{day:'2-digit',month:'short',year:'numeric'}):'—',
    dueDateRaw:r.due_date?new Date(r.due_date).getTime():0,
    notes:r.description||'', completedAt:r.completed_at||null,
    createdAt:r.created_at?r.created_at.split('T')[0]:'', _fromDB:true };
}
function mapReminderFromDB(r) {
  if(!r)return null;
  return { id:r.id, title:r.title||'', type:r.type||'Operasyon Notu',
    status:r.is_done?'Tamamlandı':'Açık', priority:_TP_APP[r.priority]||r.priority||'Orta',
    source:r.source||'manuel', assigneeId:r.assigned_to||null, customerId:r.customer_id||null,
    leadId:r.lead_id||null, resId:r.reservation_id||null,
    dueDate:r.remind_at?new Date(r.remind_at).toLocaleDateString('tr-TR',{day:'2-digit',month:'short',year:'numeric'}):'—',
    dueDateRaw:r.remind_at?new Date(r.remind_at).getTime():0,
    notes:r.description||'', doneAt:r.done_at||null,
    createdAt:r.created_at?r.created_at.split('T')[0]:'', _fromDB:true };
}
function mapActivityFromDB(r) {
  if(!r)return null;
  const dt=new Date(r.created_at||Date.now());
  const tm={lead:'lead',quote:'quote',payment:'payment',reservation:'reservation',customer:'reply',task:'task',call:'call'};
  return { id:r.id, entityType:r.entity_type, entityId:r.entity_id, action:r.action,
    description:r.description, type:tm[r.entity_type]||r.entity_type, detail:r.description,
    date:dt.toLocaleDateString('tr-TR',{day:'2-digit',month:'short'}),
    time:dt.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}),
    who:r.performer?.full_name||r.performed_by||'—', performedBy:r.performed_by,
    createdAt:r.created_at, _fromDB:true };
}

async function _updateResPayStatus(sb, resId) {
  try {
    const {data:pays}=await sb.from('payments').select('amount,status').eq('reservation_id',resId);
    const {data:res}=await sb.from('reservations').select('total_amount').eq('id',resId).single();
    if(!pays||!res)return;
    const paid=pays.filter(p=>p.status==='paid').reduce((s,p)=>s+parseFloat(p.amount||0),0);
    const total=parseFloat(res.total_amount||0);
    let ps='pending';
    if(paid>=total&&total>0)ps='paid'; else if(paid>0)ps='deposit_paid';
    await sb.from('reservations').update({payment_status:ps}).eq('id',resId);
  } catch(_) {}
}

const SupabaseCustomerRepo = {
  async getAll(f={}) {
    const sb=getSB(); if(!sb)return CustomerRepository.getAll(f);
    let q=sb.from('customers').select('id,full_name,email,phone,nationality,language,notes,tags,import_type,is_active,source_id,created_at,updated_at').eq('is_active',true).order('created_at',{ascending:false});
    if(f?.search)q=q.or(`full_name.ilike.%${f.search}%,email.ilike.%${f.search}%,phone.ilike.%${f.search}%`);
    const {data,error}=await q; if(error)throw new Error(error.message);
    return (data||[]).map(mapCustomerFromDB);
  },
  async getById(id){const sb=getSB();if(!sb)return CustomerRepository.getById(id);const{data,error}=await sb.from('customers').select('*').eq('id',id).maybeSingle();if(error)throw new Error(error.message);return mapCustomerFromDB(data);},
  async findByContact({email,phone}){const sb=getSB();if(!sb)return CustomerRepository.findByContact({email,phone});if(!email&&!phone)return null;let q=sb.from('customers').select('*');if(email&&phone)q=q.or(`email.eq.${email},phone.eq.${phone}`);else if(email)q=q.eq('email',email);else q=q.eq('phone',phone);const{data}=await q.limit(1).maybeSingle();return mapCustomerFromDB(data);},
  async create(d){const sb=getSB();if(!sb)return CustomerRepository.create(d);const row=mapCustomerToDB(d);if(!row.full_name)row.full_name=d.name||'Bilinmiyor';row.is_active=true;row.import_type=d.importType||'manual';const{data:c,error}=await sb.from('customers').insert(row).select().single();if(error)throw new Error(error.message);try{await _sbLog('customer',c.id,'created',`Yeni misafir: ${c.full_name}`);}catch(_){}return mapCustomerFromDB(c);},
  async update(id,p){const sb=getSB();if(!sb)return CustomerRepository.update(id,p);const row=mapCustomerToDB(p);const{data:u,error}=await sb.from('customers').update(row).eq('id',id).select().single();if(error)throw new Error(error.message);return mapCustomerFromDB(u);},
  async delete(id){const sb=getSB();if(!sb)return CustomerRepository.delete(id);const{error}=await sb.from('customers').update({is_active:false}).eq('id',id);if(error)throw new Error(error.message);return true;},
};

const SupabaseLeadRepo = {
  async getAll(f={}){const sb=getSB();if(!sb)return LeadRepository.getAll(f);let q=sb.from('leads').select('*,customer:customers(id,full_name,email,phone,nationality)').order('created_at',{ascending:false});if(f?.status)q=q.eq('status',_A2S[f.status]||f.status);if(f?.customerId)q=q.eq('customer_id',f.customerId);if(f?.search)q=q.or(`contact_name.ilike.%${f.search}%,destination.ilike.%${f.search}%,lead_number.ilike.%${f.search}%`);const{data,error}=await q;if(error)throw new Error(error.message);return(data||[]).map(mapLeadFromDB);},
  async getById(id){const sb=getSB();if(!sb)return LeadRepository.getById(id);const{data,error}=await sb.from('leads').select('*,customer:customers(*),source:sources(*)').eq('id',id).maybeSingle();if(error)throw new Error(error.message);return mapLeadFromDB(data);},
  async getByCustomerId(cid){const sb=getSB();if(!sb)return LeadRepository.getByCustomerId(cid);const{data,error}=await sb.from('leads').select('*').eq('customer_id',cid).order('created_at',{ascending:false});if(error)throw new Error(error.message);return(data||[]).map(mapLeadFromDB);},
  async create(d){const sb=getSB();if(!sb)return LeadRepository.create(d);let ln=`LEAD-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;try{const{data:ref}=await sb.rpc('next_ref_number',{prefix:'LEAD',table_name:'leads',number_col:'lead_number'});if(ref)ln=ref;}catch(_){}const row={lead_number:ln,customer_id:d.customerId||null,contact_name:d.name||d.contact_name||'Bilinmiyor',contact_phone:d.phone||null,contact_email:d.email||null,status:'new',source_id:d.sourceId||null,import_type:d.importType||'manual',destination:d.tour||d.destination||null,travel_start_date:d.travelStart||null,pax_adult:parseInt(d.paxAdult)||1,pax_child:parseInt(d.paxChild)||0,currency:d.currency||'EUR',notes:d.notes||null,assigned_to:d.assigneeId||null};const{data:c,error}=await sb.from('leads').insert(row).select().single();if(error)throw new Error(error.message);try{await _sbLog('lead',c.id,'created',`Yeni talep: ${c.destination||c.lead_number}`);}catch(_){}return mapLeadFromDB(c);},
  async update(id,p){const sb=getSB();if(!sb)return LeadRepository.update(id,p);const fm={status:'status',notes:'notes',assigneeId:'assigned_to',paxAdult:'pax_adult',currency:'currency',travelStart:'travel_start_date'};const row={};for(const[k,v]of Object.entries(p)){const col=fm[k]||k;row[col]=col==='status'?(_A2S[v]||v):v;}const{data:u,error}=await sb.from('leads').update(row).eq('id',id).select().single();if(error)throw new Error(error.message);if(p.status)await _sbLog('lead',id,'status_changed',`Durum → ${p.status}`);return mapLeadFromDB(u);},
  async delete(id){const sb=getSB();if(!sb)return LeadRepository.delete(id);const{error}=await sb.from('leads').update({status:'lost',closed_at:new Date().toISOString()}).eq('id',id);if(error)throw new Error(error.message);return true;},
};

const SupabaseReservationRepo = {
  async getAll(f={}){const sb=getSB();if(!sb)return ReservationRepository.getAll(f);let q=sb.from('reservations').select('*,customer:customers(id,full_name,email,phone,nationality),tour:tours(id,name,category)').order('check_in',{ascending:true});if(f.status)q=q.eq('status',_r2DB(f.status));if(f.payStatus)q=q.eq('payment_status',_p2DB(f.payStatus));if(f.customerId)q=q.eq('customer_id',f.customerId);if(f.search)q=q.or(`reservation_number.ilike.%${f.search}%,destination.ilike.%${f.search}%`);const{data,error}=await q;if(error)throw new Error(error.message);return(data||[]).map(mapResFromDB);},
  async getById(id){const sb=getSB();if(!sb)return ReservationRepository.getById(id);const{data,error}=await sb.from('reservations').select('*,customer:customers(*),tour:tours(*)').eq('id',id).maybeSingle();if(error)throw new Error(error.message);return mapResFromDB(data);},
  async getByCustomerId(cid){const sb=getSB();if(!sb)return ReservationRepository.getByCustomerId(cid);const{data,error}=await sb.from('reservations').select('*').eq('customer_id',cid).order('check_in',{ascending:false});if(error)throw new Error(error.message);return(data||[]).map(mapResFromDB);},
  async create(d){const sb=getSB();if(!sb)return ReservationRepository.create(d);let rn=`R-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;try{const{data:ref}=await sb.rpc('next_ref_number',{prefix:'R',table_name:'reservations',number_col:'reservation_number'});if(ref)rn=ref;}catch(_){}const row={reservation_number:rn,lead_id:d.leadId||null,quote_id:d.quoteId||null,customer_id:d.customerId,tour_id:d.tourId||null,status:'pending_confirmation',payment_status:'pending',destination:d.tour||d.destination||'',check_in:d.checkIn||d.date||null,check_out:d.checkOut||d.date||null,check_in_time:d.time||null,pax_adult:parseInt(d.pax||d.paxAdult)||1,pax_child:parseInt(d.paxChild)||0,guide_name:d.guide||null,vehicle_info:d.vehicle||null,driver_name:d.driver||null,pickup_location:d.pickup||null,pickup_time:d.pickupTime||null,total_amount:parseFloat(d.total)||0,currency:d.currency||'EUR',deposit_amount:parseFloat(d.deposit)||0,notes:d.opNotes||d.notes||null,assigned_to:d.assigneeId||null};const{data:c,error}=await sb.from('reservations').insert(row).select().single();if(error)throw new Error(error.message);await _sbLog('reservation',c.id,'created',`Rezervasyon: ${c.reservation_number}`);return mapResFromDB(c);},
  async update(id,p){const sb=getSB();if(!sb)return ReservationRepository.update(id,p);const fm={opStatus:'status',payStatus:'payment_status',guide:'guide_name',vehicle:'vehicle_info',driver:'driver_name',pickup:'pickup_location',opNotes:'notes',total:'total_amount'};const row={};for(const[k,v]of Object.entries(p)){const col=fm[k]||k;if(col==='status')row[col]=_r2DB(v);else if(col==='payment_status')row[col]=_p2DB(v);else row[col]=v;}if(p.opStatus==='Tamamlandı')row.completed_at=new Date().toISOString();if(p.opStatus==='İptal')row.cancelled_at=new Date().toISOString();const{data:u,error}=await sb.from('reservations').update(row).eq('id',id).select().single();if(error)throw new Error(error.message);await _sbLog('reservation',id,'updated',`Güncellendi: ${Object.keys(p).join(', ')}`);return mapResFromDB(u);},
  async delete(id){const sb=getSB();if(!sb)return ReservationRepository.delete(id);const{error}=await sb.from('reservations').update({status:'cancelled',cancelled_at:new Date().toISOString()}).eq('id',id);if(error)throw new Error(error.message);return true;},
};

const SupabasePaymentRepo = {
  async getAll(f={}){const sb=getSB();if(!sb)return PaymentRepository.getAll(f);let q=sb.from('payments').select('*,customer:customers(id,full_name),reservation:reservations(id,reservation_number,destination)').order('created_at',{ascending:false});if(f.status)q=q.eq('status',f.status);if(f.customerId)q=q.eq('customer_id',f.customerId);if(f.resId)q=q.eq('reservation_id',f.resId);if(f.currency)q=q.eq('currency',f.currency);const{data,error}=await q;if(error)throw new Error(error.message);return(data||[]).map(mapPayFromDB);},
  async getById(id){const sb=getSB();if(!sb)return PaymentRepository.getById(id);const{data,error}=await sb.from('payments').select('*,customer:customers(*),reservation:reservations(*)').eq('id',id).maybeSingle();if(error)throw new Error(error.message);return mapPayFromDB(data);},
  async getByResId(rid){const sb=getSB();if(!sb)return PaymentRepository.getByResId(rid);const{data,error}=await sb.from('payments').select('*').eq('reservation_id',rid).order('created_at',{ascending:true});if(error)throw new Error(error.message);return(data||[]).map(mapPayFromDB);},
  async getByCustomerId(cid){const sb=getSB();if(!sb)return PaymentRepository.getAll({customerId:cid});const{data,error}=await sb.from('payments').select('*').eq('customer_id',cid).order('created_at',{ascending:false});if(error)throw new Error(error.message);return(data||[]).map(mapPayFromDB);},
  async create(d){const sb=getSB();if(!sb)return PaymentRepository.create(d);let pn=`PAY-${String(Date.now()).slice(-6)}`;try{const{data:ref}=await sb.rpc('next_ref_number',{prefix:'PAY',table_name:'payments',number_col:'payment_number'});if(ref)pn=ref;}catch(_){}const amt=parseFloat(d.amount)||0;const sm={'Tam Ödeme':'paid','İade':'refunded','Kapora':'paid','Kalan Ödeme':'paid'};const tm={'Tam Ödeme':'full','İade':'refund','Kapora':'deposit','Kalan Ödeme':'balance'};const row={payment_number:pn,reservation_id:d.resId||d.reservationId||null,customer_id:d.customerId||null,payment_type:tm[d.paymentType]||d.paymentType?.toLowerCase()||'deposit',status:sm[d.paymentType]||'paid',amount:amt,currency:d.currency||'EUR',method:_mToDB(d.method),paid_at:new Date().toISOString(),notes:d.notes||null};const{data:c,error}=await sb.from('payments').insert(row).select().single();if(error)throw new Error(error.message);if(row.reservation_id)await _updateResPayStatus(sb,row.reservation_id);await _sbLog('payment',c.id,'payment_received',`Ödeme: ${d.currency==='TRY'?'₺':'€'}${amt.toLocaleString('tr-TR')}`);return mapPayFromDB(c);},
  async update(id,p){const sb=getSB();if(!sb)return PaymentRepository.update(id,p);const{data:u,error}=await sb.from('payments').update(p).eq('id',id).select().single();if(error)throw new Error(error.message);return mapPayFromDB(u);},
  async delete(id){const sb=getSB();if(!sb)return PaymentRepository.delete(id);const{error}=await sb.from('payments').update({status:'cancelled'}).eq('id',id);if(error)throw new Error(error.message);return true;},
};

const SupabaseTaskRepo = {
  async getAll(f={}){const sb=getSB();if(!sb)return TaskRepository.getAll(f);let q=sb.from('tasks').select('*,assignee:staff_users!assigned_to(id,full_name)').order('due_date',{ascending:true,nullsLast:true});if(f.status)q=q.eq('status',_TS_DB[f.status]||f.status);if(f.priority)q=q.eq('priority',_TP_DB[f.priority]||f.priority);if(f.customerId)q=q.eq('customer_id',f.customerId);if(f.assigneeId)q=q.eq('assigned_to',f.assigneeId);if(f.search)q=q.ilike('title',`%${f.search}%`);const{data,error}=await q;if(error)throw new Error(error.message);return(data||[]).map(mapTaskFromDB);},
  async getById(id){const sb=getSB();if(!sb)return TaskRepository.getById(id);const{data,error}=await sb.from('tasks').select('*').eq('id',id).maybeSingle();if(error)throw new Error(error.message);return mapTaskFromDB(data);},
  async getByCustomerId(cid){const sb=getSB();if(!sb)return TaskRepository.getAll({customerId:cid});const{data,error}=await sb.from('tasks').select('*').eq('customer_id',cid).order('due_date',{ascending:true,nullsLast:true});if(error)throw new Error(error.message);return(data||[]).map(mapTaskFromDB);},
  async create(d){const sb=getSB();if(!sb)return TaskRepository.create(d);const row={title:d.title,description:d.notes||d.description||null,status:'todo',priority:_TP_DB[d.priority]||'medium',category:d.category||null,assigned_to:d.assigneeId||null,customer_id:d.customerId||null,lead_id:d.leadId||null,reservation_id:d.resId||null,due_date:d.dueDate&&d.dueDate!=='—'?d.dueDate:null};const{data:c,error}=await sb.from('tasks').insert(row).select().single();if(error)throw new Error(error.message);return mapTaskFromDB(c);},
  async update(id,p){const sb=getSB();if(!sb)return TaskRepository.update(id,p);const row={};if(p.status!==undefined)row.status=_TS_DB[p.status]||p.status;if(p.priority!==undefined)row.priority=_TP_DB[p.priority]||p.priority;if(p.title!==undefined)row.title=p.title;if(p.notes!==undefined)row.description=p.notes;if(p.assigneeId!==undefined)row.assigned_to=p.assigneeId;if(p.completed_at!==undefined)row.completed_at=p.completed_at;const{data:u,error}=await sb.from('tasks').update(row).eq('id',id).select().single();if(error)throw new Error(error.message);return mapTaskFromDB(u);},
  async toggle(id){const sb=getSB();if(!sb)return TaskRepository.toggle(id);const t=await this.getById(id);if(!t)return null;const isDone=t.status!=='Tamamlandı';const u=await this.update(id,{status:isDone?'Tamamlandı':'Açık',completed_at:isDone?new Date().toISOString():null});if(isDone)await _sbLog('task',id,'completed',`Görev tamamlandı: ${t.title}`);return u;},
  async delete(id){const sb=getSB();if(!sb)return TaskRepository.delete(id);const{error}=await sb.from('tasks').update({status:'cancelled'}).eq('id',id);if(error)throw new Error(error.message);return true;},
};

const SupabaseReminderRepo = {
  async getAll(f={}){const sb=getSB();if(!sb)return ReminderRepository.getAll(f);let q=sb.from('reminders').select('*,assignee:staff_users!assigned_to(id,full_name)').order('remind_at',{ascending:true});if(f.status==='Açık')q=q.eq('is_done',false);if(f.status==='Tamamlandı')q=q.eq('is_done',true);if(f.type)q=q.eq('type',f.type);if(f.customerId)q=q.eq('customer_id',f.customerId);if(f.assigneeId)q=q.eq('assigned_to',f.assigneeId);if(f.search)q=q.ilike('title',`%${f.search}%`);const{data,error}=await q;if(error)throw new Error(error.message);return(data||[]).map(mapReminderFromDB);},
  async getById(id){const sb=getSB();if(!sb)return ReminderRepository.getById(id);const{data,error}=await sb.from('reminders').select('*').eq('id',id).maybeSingle();if(error)throw new Error(error.message);return mapReminderFromDB(data);},
  async create(d){const sb=getSB();if(!sb)return ReminderRepository.create(d);const ra=d.dueDate&&d.dueDate!=='—'?new Date(d.dueDate).toISOString():new Date(Date.now()+86400000).toISOString();const row={title:d.title,description:d.notes||null,remind_at:ra,priority:_TP_DB[d.priority]||'medium',type:d.type||null,source:d.source||'manual',is_done:false,customer_id:d.customerId||null,lead_id:d.leadId||null,reservation_id:d.resId||null,assigned_to:d.assigneeId||null};const{data:c,error}=await sb.from('reminders').insert(row).select().single();if(error)throw new Error(error.message);return mapReminderFromDB(c);},
  async update(id,p){const sb=getSB();if(!sb)return ReminderRepository.update(id,p);const row={};if(p.status!==undefined)row.is_done=p.status==='Tamamlandı';if(p.priority!==undefined)row.priority=_TP_DB[p.priority]||p.priority;if(p.title!==undefined)row.title=p.title;if(p.notes!==undefined)row.description=p.notes;if(p.done_at!==undefined)row.done_at=p.done_at;const{data:u,error}=await sb.from('reminders').update(row).eq('id',id).select().single();if(error)throw new Error(error.message);return mapReminderFromDB(u);},
  async toggle(id){const sb=getSB();if(!sb)return ReminderRepository.toggle(id);const r=await this.getById(id);if(!r)return null;const isDone=r.status!=='Tamamlandı';return this.update(id,{status:isDone?'Tamamlandı':'Açık',done_at:isDone?new Date().toISOString():null});},
  async delete(id){const sb=getSB();if(!sb)return ReminderRepository.delete(id);const{error}=await sb.from('reminders').delete().eq('id',id);if(error)throw new Error(error.message);return true;},
};

const SupabaseActivityRepo = {
  async getAll(f={}){const sb=getSB();if(!sb)return ActivityRepository.getAll(f);let q=sb.from('activity_logs').select('*,performer:staff_users!performed_by(id,full_name)').order('created_at',{ascending:false});if(f.entityType&&f.entityId)q=q.eq('entity_type',f.entityType).eq('entity_id',f.entityId);if(f.limit)q=q.limit(f.limit);const{data,error}=await q;if(error)throw new Error(error.message);return(data||[]).map(mapActivityFromDB);},
  async getByCustomerId(cid){const sb=getSB();if(!sb)return ActivityRepository.getAll({customerId:cid});const[{data:leads},{data:res},{data:pays}]=await Promise.all([sb.from('leads').select('id').eq('customer_id',cid),sb.from('reservations').select('id').eq('customer_id',cid),sb.from('payments').select('id').eq('customer_id',cid)]);const ids=[...((leads||[]).map(r=>r.id)),...((res||[]).map(r=>r.id)),...((pays||[]).map(r=>r.id)),cid];const{data,error}=await sb.from('activity_logs').select('*,performer:staff_users!performed_by(id,full_name)').in('entity_id',ids).order('created_at',{ascending:false}).limit(50);if(error)throw new Error(error.message);return(data||[]).map(mapActivityFromDB);},
  async create(d){const sb=getSB();if(!sb)return ActivityRepository.create(d);const row={entity_type:d.entityType,entity_id:d.entityId,action:d.action,description:d.description,old_value:d.oldValue||null,new_value:d.newValue||null,metadata:d.metadata||null,performed_by:d.performedBy||null};const{data:c,error}=await sb.from('activity_logs').insert(row).select().single();if(error)throw new Error(error.message);return mapActivityFromDB(c);},
};

async function autoLog(entityType, entityId, action, description) {
  if (!entityId) return;
  try { await Promise.resolve(getActiveRepo('activity').create({entityType,entityId,action,description})); }
  catch(_) {}
}

function getActiveRepo(entity) {
  const useReal = AppConfig.useSupabase && getSB() !== null;
  if(entity==='customer')   return useReal ? SupabaseCustomerRepo    : CustomerRepository;
  if(entity==='lead')       return useReal ? SupabaseLeadRepo        : LeadRepository;
  if(entity==='reservation')return useReal ? SupabaseReservationRepo : ReservationRepository;
  if(entity==='payment')    return useReal ? SupabasePaymentRepo     : PaymentRepository;
  if(entity==='task')       return useReal ? SupabaseTaskRepo        : TaskRepository;
  if(entity==='reminder')   return useReal ? SupabaseReminderRepo    : ReminderRepository;
  if(entity==='activity')   return useReal ? SupabaseActivityRepo    : ActivityRepository;
  if(entity==='quote')      return useReal ? SupabaseQuoteRepo      : QuoteRepository;
  if(entity==='tour')       return useReal ? SupabaseTourRepo        : TourRepository;
  if(entity==='staff')      return useReal ? SupabaseStaffRepo       : { getAll: async () => DB.staff };
  return null;
}

function useRepo(entity, method, arg) {
  const [state, setState] = useState({ data:null, loading:true, error:null });
  const tick = useStore();
  useEffect(() => {
    let dead = false;
    setState(p => ({ ...p, loading:true, error:null }));
    const repo = getActiveRepo(entity);
    if(!repo || typeof repo[method]!=='function'){setState({data:null,loading:false,error:`Unknown: ${entity}.${method}`});return;}
    Promise.resolve(repo[method].call(repo, arg))
      .then(data => { if(!dead) setState({data, loading:false, error:null}); })
      .catch(err  => { if(!dead) setState({data:null, loading:false, error:err.message}); });
    return () => { dead = true; };
  }, [entity, method, JSON.stringify(arg ?? null), tick]);
  function reload(){setState(p=>({...p,loading:true}));const repo=getActiveRepo(entity);Promise.resolve(repo[method].call(repo,arg)).then(data=>setState({data,loading:false,error:null})).catch(err=>setState({data:null,loading:false,error:err.message}));}
  return { ...state, reload };
}

function useRepoMutation(entity) {
  const [mutating, setMutating] = useState(false);
  async function mutate(method, ...args) {
    setMutating(true);
    try { const r=await Promise.resolve(getActiveRepo(entity)[method].call(getActiveRepo(entity),...args));Store.notify();return{data:r,error:null}; }
    catch(e) { return{data:null,error:e.message}; }
    finally { setMutating(false); }
  }
  return { mutate, mutating };
}

function LoadingState({ label }) {
  return (
    <div style={{padding:"52px 20px",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
      <div style={{width:34,height:34,borderRadius:"50%",border:`3px solid ${C.borderLight}`,borderTopColor:C.gold,animation:"spin .75s linear infinite"}}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <span style={{fontSize:13,color:C.textMuted,fontFamily:"'DM Sans',sans-serif"}}>{label||"Yükleniyor…"}</span>
    </div>
  );
}
function ErrorState({ message, onRetry }) {
  return (
    <div style={{padding:"44px 20px",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
      <div style={{width:42,height:42,borderRadius:"50%",background:C.redBg,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.red} strokeWidth="2" strokeLinecap="round"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
      </div>
      <div style={{fontSize:13.5,fontWeight:600,color:C.text,fontFamily:"'Playfair Display',serif"}}>Veriler yüklenemedi</div>
      <div style={{fontSize:12.5,color:C.textMuted,fontFamily:"'DM Sans',sans-serif"}}>{message||"Veriler yüklenirken bir hata oluştu."}</div>
      {onRetry && <button onClick={onRetry} style={{padding:"7px 16px",borderRadius:7,cursor:"pointer",border:`1px solid ${C.border}`,background:C.white,color:C.text,fontFamily:"'DM Sans',sans-serif",fontSize:13}}>Tekrar Dene</button>}
    </div>
  );
}
function EmptyState({ icon, title, subtitle, action }) {
  return (
    <div style={{padding:"60px 20px",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
      <div style={{fontSize:34,opacity:.18,marginBottom:4}}>{icon||"📭"}</div>
      <div style={{fontSize:15,fontWeight:600,color:C.text,fontFamily:"'Playfair Display',serif"}}>{title||"Henüz kayıt bulunmuyor."}</div>
      {subtitle && <div style={{fontSize:13,color:C.textMuted,fontFamily:"'DM Sans',sans-serif",maxWidth:280}}>{subtitle}</div>}
      {action && <div style={{marginTop:6}}>{action}</div>}
    </div>
  );
}
function DataSourceBadge() {
  const emailLabel = AppConfig.useResend ? '✉ Resend' : '✉ Mock';
  return (
    <div style={{position:"fixed",bottom:10,left:10,zIndex:9000,fontSize:10,fontWeight:600,letterSpacing:"0.06em",color:AppConfig.useSupabase?"#128C7E":C.textFaint,background:AppConfig.useSupabase?"#E7F5F3":C.ivoryDark,border:`1px solid ${AppConfig.useSupabase?"#128C7E44":C.border}`,padding:"2px 10px",borderRadius:99,fontFamily:"'DM Mono',monospace",pointerEvents:"none",userSelect:"none",display:"flex",gap:8}}>
      <span>{AppConfig.dataSource}</span>
      <span style={{opacity:0.5}}>·</span>
      <span style={{color:AppConfig.useResend?"#7C3AED":C.textFaint}}>{emailLabel}</span>
    </div>
  );
}

const ROLE_PERMISSIONS = {
  "Yönetici": null, // null = all pages
  "Satış":    ["dashboard","leads","customers","quotes","tasks","reminders","messages","reports","more"],
  "Operasyon":["dashboard","reservations","calendar","tours","tasks","reminders","payments","reports","more"],
  "Rehber":   ["dashboard","calendar","reservations","tasks","more"],
};

function canAccess(role, page) {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role];
  if (perms === null) return true; // Yönetici
  return perms ? perms.includes(page) : false;
}

async function loadStaffData(userId) {
  const sb = getSB();
  if (!sb) return null;
  try {
    const { data } = await sb.from('staff_users').select('*').eq('id', userId).single();
    return data || null;
  } catch(_) { return null; }
}

// A hung Supabase call (paused project, unreachable network, bad API key)
// must not leave the app stuck in authLoading forever. Race any session
// check against a deterministic timeout so the auth flow always finishes.
function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label || 'İşlem'} zaman aşımına uğradı (${ms}ms)`)), ms)),
  ]);
}

// Module-level auth cache — survives re-renders and page navigation
let _authCache = null;
let _authListeners = [];
function _notifyAuthListeners() { _authListeners.forEach(fn => fn(_authCache)); }

function useAuth() {
  const [authState, setAuthState] = useState(() => _authCache || {
    session: null, staff: null, authLoading: true
  });

  const session    = authState.session;
  const staff      = authState.staff;
  const authLoading = authState.authLoading;
  const authError   = authState.authError || null;

  function updateAuth(patch) {
    _authCache = { ...(_authCache || { session:null, staff:null, authLoading:true }), ...patch };
    _notifyAuthListeners();
  }

  useEffect(() => {
    // Subscribe to future auth changes
    const listener = (state) => setAuthState({ ...state });
    _authListeners.push(listener);

    // If already loaded (navigated back), use cached state immediately
    if (_authCache && !_authCache.authLoading) {
      setAuthState({ ..._authCache });
      return () => { _authListeners = _authListeners.filter(l => l !== listener); };
    }

    const sb = getSB();

    if (!sb) {
      const mockStaff = DB.staff[0] || { id:"STAFF-001", name:"Berk Çetinkaya", initials:"BÇ",
        email:"berk@desetour.com", role:"Yönetici", active:true };
      const newState = {
        session: { user:{ email:mockStaff.email, id:mockStaff.id } },
        staff:   { ...mockStaff, full_name:mockStaff.name },
        authLoading: false,
      };
      _authCache = newState;
      setAuthState(newState);
      return () => { _authListeners = _authListeners.filter(l => l !== listener); };
    }

    async function init() {
      // Step 1: determine whether a session exists at all. Only a failure
      // *here* means we genuinely can't tell if the user is logged in, so
      // only this step is allowed to fail closed to the login screen.
      let s = null;
      try {
        const { data } = await _withTimeout(sb.auth.getSession(), 12000, 'Oturum kontrolü');
        s = data?.session || null;
      } catch(e) {
        console.error('[Auth] getSession() failed:', e);
        const newState = { session:null, staff:null, authLoading:false, authError:e.message };
        _authCache = newState;
        setAuthState(newState);
        _notifyAuthListeners();
        return;
      }
      // Step 2: the session check above succeeded (session may legitimately
      // be null, i.e. genuinely signed out). A failure fetching the staff
      // profile below is a separate concern — it must NOT wipe out a valid
      // session. Keep `s` as-is either way; only `staff`/`authError` reflect
      // this step's outcome.
      let st = null, staffErr = null;
      if (s?.user) {
        try {
          st = await _withTimeout(loadStaffData(s.user.id), 12000, 'Personel profili');
        } catch(e) {
          console.error('[Auth] staff profile lookup failed (session kept):', e);
          staffErr = e.message;
        }
      }
      const newState = { session:s, staff:st, authLoading:false, authError:staffErr };
      _authCache = newState;
      setAuthState(newState);
      _notifyAuthListeners();
    }
    init();

    const { data:{ subscription } } = sb.auth.onAuthStateChange(async (_ev, s) => {
      // Same principle: `s` (null or a session) comes straight from the
      // auth event itself — a staff_users lookup failure must not override
      // it with `null`, or a transient DB hiccup during an active session
      // (e.g. right after some unrelated insert) would look like a logout.
      let st = null, staffErr = null;
      if (s?.user) {
        try {
          st = await _withTimeout(loadStaffData(s.user.id), 12000, 'Personel profili');
        } catch(e) {
          console.error('[Auth] onAuthStateChange staff lookup failed (session kept):', e);
          staffErr = e.message;
        }
      }
      const newState = { session:s, staff:st, authLoading:false, authError:staffErr };
      _authCache = newState;
      setAuthState(newState);
      _notifyAuthListeners();
    });
    return () => {
      subscription?.unsubscribe?.();
      _authListeners = _authListeners.filter(l => l !== listener);
    };
  }, []);

  // loadStaffData is now a module-level helper (defined below useAuth)

  async function login(email, password) {
    const sb = getSB();
    if (!sb) {
      const found = DB.staff.find(s => s.email === email);
      if (found && password === "demo") {
        const mockUser = { ...found, full_name:found.name };
        setStaff(mockUser);
        setSession({ user:{ email:found.email, id:found.id } });
        return { error:null };
      }
      return { error:"Hatalı email veya şifre." };
    }
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { error: "Hatalı email veya şifre." };
    return { error:null };
  }

  async function logout() {
    const sb = getSB();
    if (sb) await sb.auth.signOut();
    setSession(null);
    setStaff(null);
    if (typeof NAV_REF.fn === 'function') NAV_REF.fn('/login');
  }

  const displayName = staff?.full_name || staff?.name || "—";
  const initials    = displayName.split(" ").map(w=>w[0]||"").join("").slice(0,2).toUpperCase() || "?";
  // Map Supabase DB role values → Turkish display roles used in ROLE_PERMISSIONS
  const ROLE_MAP = {
    'admin':      'Yönetici',
    'sales':      'Satış',
    'operations': 'Operasyon',
    'guide':      'Rehber',
  };
  const rawRole = staff?.role || 'admin';
  const role    = ROLE_MAP[rawRole] || rawRole;

  return { session, staff, authLoading, authError, login, logout, displayName, initials, role, isLoggedIn:!!session };
}

const AuthContext = createContext(null);
function useAuthContext() { return useContext(AuthContext); }

function LoginPage({ onLogin, connectionError }) {
  const [email,      setEmail]      = useState("");
  const [password,   setPassword]   = useState("");
  const [error,      setError]      = useState("");
  const [loading,    setLoading]    = useState(false);
  const [showPass,   setShowPass]   = useState(false);
  const [resetMode,  setResetMode]  = useState(false);
  const [resetSent,  setResetSent]  = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetBusy,  setResetBusy]  = useState(false);
  const [resetError, setResetError] = useState("");
  const { login } = useAuth();

  async function handleReset() {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!resetEmail || !emailRe.test(resetEmail)) {
      setResetError("Geçerli bir e-posta adresi girin.");
      return;
    }
    setResetBusy(true);
    setResetError("");
    const sb = getSB();
    if (sb) {
      const { error:err } = await sb.auth.resetPasswordForEmail(resetEmail, {
        redirectTo: window.location.origin + "/#/reset-password",
      });
      if (err) {
        setResetError("Gönderme hatası: " + err.message);
      } else {
        setResetSent(true);
      }
    } else {
      setTimeout(() => setResetSent(true), 800);
    }
    setResetBusy(false);
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    if (!email || !password) { setError("Email ve şifre zorunludur."); return; }
    setLoading(true);
    setError("");
    const { error:err } = await login(email, password);
    setLoading(false);
    if (err) { setError(err); return; }
    onLogin && onLogin();
  }

  return (
    <div style={{
      minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center",
      background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 60%, #2C3E6B 100%)`,
      padding:20, position:"relative", overflow:"hidden",
    }}>
      {}
      <div style={{position:"absolute",top:-80,right:-80,width:320,height:320,borderRadius:"50%",background:"rgba(201,168,76,0.06)",pointerEvents:"none"}}/>
      <div style={{position:"absolute",bottom:-60,left:-60,width:240,height:240,borderRadius:"50%",background:"rgba(201,168,76,0.04)",pointerEvents:"none"}}/>

      <div style={{
        background:C.white, borderRadius:16, padding:"44px 40px",
        width:"100%", maxWidth:400, boxShadow:"0 24px 80px rgba(13,27,62,0.45)",
        position:"relative",
      }}>
        {}
        <div style={{textAlign:"center", marginBottom:32}}>
          <div style={{marginBottom:14}}>
            {/* Transparent-background export of the same logo asset used
                elsewhere — the original file is a flattened JPEG with a
                black canvas, which shows as a black box on this white
                card. See seffafdeselogo-transparent.png. */}
            <img src="/seffafdeselogo-transparent.png" alt="Dese Tour"
              style={{height:64, width:"auto"}}
            />
          </div>
          <div style={{fontSize:13, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
            Operations Center'a hoş geldiniz
          </div>
        </div>

        {}
        {!error && connectionError && (
          <div style={{
            padding:"11px 14px", borderRadius:8, marginBottom:20,
            background:"#FEF3E2", border:"1px solid #FDE0A6",
            display:"flex", flexDirection:"column", gap:8,
          }}>
            <div style={{display:"flex", alignItems:"center", gap:9}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B45309" strokeWidth="2" strokeLinecap="round">
                <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              </svg>
              <span style={{fontSize:13, color:"#B45309", fontFamily:"'DM Sans',sans-serif"}}>
                Oturum durumu doğrulanamadı. Supabase bağlantısı kontrol edilemedi.
              </span>
            </div>
            <button onClick={()=>window.location.reload()} style={{
              alignSelf:"flex-start", padding:"6px 12px", borderRadius:6, cursor:"pointer",
              border:"1px solid #FDE0A6", background:"#fff", color:"#B45309",
              fontSize:12, fontWeight:500, fontFamily:"'DM Sans',sans-serif",
            }}>Tekrar Dene</button>
          </div>
        )}
        {error && (
          <div style={{
            padding:"11px 14px", borderRadius:8, marginBottom:20,
            background:"#FDF2F2", border:"1px solid #FECACA",
            display:"flex", alignItems:"center", gap:9,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
            </svg>
            <span style={{fontSize:13, color:"#DC2626", fontFamily:"'DM Sans',sans-serif"}}>{error}</span>
          </div>
        )}

        {}
        <div style={{display:"flex", flexDirection:"column", gap:16}}>
          {}
          <div>
            <label style={{display:"block", fontSize:12.5, fontWeight:500, color:C.textMid, fontFamily:"'DM Sans',sans-serif", marginBottom:6}}>
              E-posta
            </label>
            <input
              type="email" value={email} onChange={e=>setEmail(e.target.value)}
              placeholder="ad@desetour.com"
              onKeyDown={e=>e.key==="Enter"&&handleSubmit()}
              style={{
                width:"100%", boxSizing:"border-box",
                padding:"11px 14px", borderRadius:8,
                border:`1.5px solid ${error&&!email?C.red:C.border}`,
                fontSize:14, color:C.text, fontFamily:"'DM Sans',sans-serif",
                outline:"none", background:C.white,
                transition:"border-color .15s",
              }}
              onFocus={e=>e.target.style.borderColor=C.navy}
              onBlur={e=>e.target.style.borderColor=C.border}
            />
          </div>

          {}
          <div>
            <label style={{display:"block", fontSize:12.5, fontWeight:500, color:C.textMid, fontFamily:"'DM Sans',sans-serif", marginBottom:6}}>
              Şifre
            </label>
            <div style={{position:"relative"}}>
              <input
                type={showPass?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)}
                placeholder="••••••••"
                onKeyDown={e=>e.key==="Enter"&&handleSubmit()}
                style={{
                  width:"100%", boxSizing:"border-box",
                  padding:"11px 42px 11px 14px", borderRadius:8,
                  border:`1.5px solid ${error&&!password?C.red:C.border}`,
                  fontSize:14, color:C.text, fontFamily:"'DM Sans',sans-serif",
                  outline:"none", background:C.white,
                  transition:"border-color .15s",
                }}
                onFocus={e=>e.target.style.borderColor=C.navy}
                onBlur={e=>e.target.style.borderColor=C.border}
              />
              <button onClick={()=>setShowPass(v=>!v)} style={{
                position:"absolute", right:12, top:"50%", transform:"translateY(-50%)",
                background:"none", border:"none", cursor:"pointer", padding:0, color:C.textFaint,
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  {showPass
                    ? <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>
                    : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                  }
                </svg>
              </button>
            </div>
          </div>

          {}
          <button onClick={handleSubmit} disabled={loading} style={{
            width:"100%", padding:"13px", borderRadius:9, border:"none",
            background: loading
              ? C.textFaint
              : `linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
            color:C.white, fontSize:14.5, fontWeight:600,
            fontFamily:"'DM Sans',sans-serif", cursor:loading?"not-allowed":"pointer",
            boxShadow: loading?"none":"0 4px 16px rgba(13,27,62,0.35)",
            display:"flex", alignItems:"center", justifyContent:"center", gap:8,
            transition:"all .15s", marginTop:4,
          }}>
            {loading && <div style={{width:16,height:16,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.4)",borderTopColor:"#fff",animation:"spin .7s linear infinite"}}/>}
            {loading ? "Giriş yapılıyor…" : "Giriş Yap"}
          </button>
        </div>

        {}
        {!AppConfig.useSupabase && (
          <div style={{
            marginTop:24, padding:"11px 14px", borderRadius:8,
            background:"rgba(201,168,76,0.08)", border:"1px solid rgba(201,168,76,0.25)",
          }}>
            <div style={{fontSize:11.5, color:C.amber, fontFamily:"'DM Sans',sans-serif", fontWeight:600, marginBottom:5}}>
              Demo Modu
            </div>
            <div style={{fontSize:11.5, color:C.textMid, fontFamily:"'DM Sans',sans-serif", lineHeight:1.6}}>
              {DB.staff.slice(0,3).map(s=>(
                <div key={s.id}>{s.email} — <strong>demo</strong> ({s.role})</div>
              ))}
            </div>
          </div>
        )}

        {}
        {!resetMode && (
          <div style={{textAlign:"center", marginTop:16}}>
            <button onClick={()=>{ setResetMode(true); setError(""); setResetEmail(email); }}
              style={{background:"none",border:"none",cursor:"pointer",color:C.textFaint,
                fontSize:12.5,fontFamily:"'DM Sans',sans-serif",textDecoration:"underline"}}>
              Şifremi unuttum
            </button>
          </div>
        )}

        {}
        {resetMode && !resetSent && (
          <div style={{marginTop:20,padding:"16px",borderRadius:10,background:C.ivory,border:`1px solid ${C.border}`}}>
            <div style={{fontSize:13.5,fontWeight:600,color:C.text,fontFamily:"'Playfair Display',serif",marginBottom:12}}>
              Şifre Sıfırlama
            </div>
            <div style={{fontSize:12.5,color:C.textMuted,fontFamily:"'DM Sans',sans-serif",marginBottom:12,lineHeight:1.5}}>
              E-posta adresinize şifre sıfırlama bağlantısı göndereceğiz.
            </div>
            {resetError && (
              <div style={{fontSize:12,color:C.red,marginBottom:8,fontFamily:"'DM Sans',sans-serif"}}>{resetError}</div>
            )}
            <input type="email" value={resetEmail} onChange={e=>setResetEmail(e.target.value)}
              placeholder="E-posta adresiniz"
              style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:7,
                border:`1.5px solid ${C.border}`,fontSize:13.5,color:C.text,
                fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:10}}/>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setResetMode(false)}
                style={{flex:1,padding:"9px",borderRadius:7,border:`1px solid ${C.border}`,
                  background:C.white,color:C.textMid,fontSize:13,cursor:"pointer",
                  fontFamily:"'DM Sans',sans-serif"}}>İptal</button>
              <button onClick={handleReset} disabled={resetBusy}
                style={{flex:2,padding:"9px",borderRadius:7,border:"none",
                  background:C.navy,color:C.white,fontSize:13,cursor:resetBusy?"not-allowed":"pointer",
                  fontFamily:"'DM Sans',sans-serif",fontWeight:500}}>
                {resetBusy?"Gönderiliyor…":"Bağlantı Gönder"}
              </button>
            </div>
          </div>
        )}

        {resetSent && (
          <div style={{marginTop:20,padding:"16px",borderRadius:10,
            background:"rgba(46,125,82,0.07)",border:"1px solid rgba(46,125,82,0.25)"}}>
            <div style={{fontSize:13,color:C.green,fontFamily:"'DM Sans',sans-serif",fontWeight:600,marginBottom:4}}>
              ✓ Bağlantı gönderildi
            </div>
            <div style={{fontSize:12.5,color:C.textMuted,fontFamily:"'DM Sans',sans-serif",lineHeight:1.5}}>
              {AppConfig.useSupabase
                ? `${resetEmail} adresine şifre sıfırlama bağlantısı gönderildi. Spam klasörünüzü kontrol edin.`
                : "Demo mod: gerçek e-posta gönderilmedi. Şifre: demo"}
            </div>
            <button onClick={()=>{setResetMode(false);setResetSent(false);}}
              style={{marginTop:10,background:"none",border:"none",cursor:"pointer",
                color:C.navy,fontSize:12.5,fontFamily:"'DM Sans',sans-serif",textDecoration:"underline"}}>
              Giriş sayfasına dön
            </button>
          </div>
        )}

        <div style={{textAlign:"center", marginTop:20, fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
          Dese Tour Operations Center v1.0
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function AccessDenied({ page }) {
  return (
    <div style={{
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      padding:"80px 40px", textAlign:"center", gap:16,
    }}>
      <div style={{
        width:60, height:60, borderRadius:"50%", background:C.redBg,
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={C.red} strokeWidth="2" strokeLinecap="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
      <div>
        <div style={{fontSize:18, fontWeight:600, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:8}}>
          Erişim Yetkisi Yok
        </div>
        <div style={{fontSize:14, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", maxWidth:340}}>
          Bu sayfaya erişim yetkiniz bulunmuyor.
          {page && ` (${page})`}
        </div>
      </div>
    </div>
  );
}

function AuthGuard({ children }) {
  const auth = useAuth();

  AuthGuard._current = auth;

  if (auth.authLoading) {
    return (
      <div style={{
        minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center",
        background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
      }}>
        <div style={{textAlign:"center"}}>
          <div style={{
            width:44, height:44, borderRadius:"50%",
            border:"3px solid rgba(201,168,76,0.3)", borderTopColor:C.gold,
            animation:"spin .8s linear infinite", margin:"0 auto 16px",
          }}/>
          <div style={{fontSize:14, color:"rgba(248,245,238,0.7)", fontFamily:"'DM Sans',sans-serif"}}>
            Yükleniyor…
          </div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      </div>
    );
  }

  if (!auth.isLoggedIn) {
    return <LoginPage
      onLogin={()=>{ if (typeof NAV_REF.fn === 'function') NAV_REF.fn('/dashboard'); }}
      connectionError={auth.authError}
    />;
  }

  return (
    <AuthContext.Provider value={auth}>
      {children}
    </AuthContext.Provider>
  );
}

function getAuthContext() {
  return AuthGuard._current || {
    displayName: DB.staff[0]?.name || "Berk Çetinkaya",
    initials:    "BÇ",
    role:        "Yönetici",
    isLoggedIn:  true,
    logout:      ()=>{},
  };
}

function validate(rules, values) {
  const errs = {};
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phoneRe = /^[\+]?[(]?[0-9]{1,4}[)]?[-\s\./0-9]{7,15}$/;

  Object.entries(rules).forEach(([field, checks]) => {
    const val = values[field];
    const str = String(val ?? '').trim();

    if (checks.required && (!str || str === '—')) {
      errs[field] = typeof checks.required === 'string' ? checks.required : `${field} zorunludur`;
      return;
    }
    if (!str) return; // empty + not required → skip further checks

    if (checks.email && !emailRe.test(str)) {
      errs[field] = typeof checks.email === 'string' ? checks.email : 'Geçerli bir e-posta girin.';
      return;
    }
    if (checks.phone && !phoneRe.test(str.replace(/\s/g,''))) {
      errs[field] = typeof checks.phone === 'string' ? checks.phone : 'Geçerli bir telefon numarası girin.';
      return;
    }
    if (checks.number) {
      const n = parseFloat(str);
      if (isNaN(n)) {
        errs[field] = typeof checks.number === 'string' ? checks.number : 'Sayısal bir değer girin.';
        return;
      }
      if (checks.min !== undefined && n < checks.min) {
        errs[field] = `Değer en az ${checks.min} olmalıdır.`;
        return;
      }
      if (checks.max !== undefined && n > checks.max) {
        errs[field] = `Değer en fazla ${checks.max} olmalıdır.`;
        return;
      }
    }
    if (checks.minLen && str.length < checks.minLen) {
      errs[field] = `En az ${checks.minLen} karakter girilmelidir.`;
    }
  });
  return errs;
}

function Modal({ title, onClose, onSubmit, submitLabel, children, wide, danger }) {
  const { isMobile } = useBreakpoint();
  // Lock background scroll while any modal is open — the sheet behind it
  // must not move underneath the user's thumb on mobile.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:1000,
      background:"rgba(13,27,62,0.55)", backdropFilter:"blur(3px)",
      display:"flex", alignItems:"center", justifyContent:"center",
      padding: isMobile ? 0 : 16,
    }} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="modal-inner" style={{
        background:C.white, borderRadius:12,
        width:"100%", maxWidth: wide ? 720 : 520,
        maxHeight:"90vh", overflowY:"auto", overflowX:"hidden",
        boxShadow:"0 24px 64px rgba(13,27,62,0.4)",
        display:"flex", flexDirection:"column",
        boxSizing:"border-box",
      }}>
        {}
        <div style={{
          padding:"18px 24px", borderBottom:`1px solid ${C.borderLight}`,
          display:"flex", alignItems:"center", justifyContent:"space-between",
          flexShrink:0,
        }}>
          <div style={{fontSize:17, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif"}}>
            {title}
          </div>
          <button onClick={onClose} style={{
            width:32, height:32, borderRadius:7, border:`1px solid ${C.border}`,
            background:"transparent", cursor:"pointer", color:C.textFaint,
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
        {}
        <div style={{padding: isMobile ? "18px 16px" : "22px 24px", flex:1, overflowY:"auto"}}>
          {children}
        </div>
        {}
        <div style={{
          padding: isMobile
            ? "12px 16px calc(12px + env(safe-area-inset-bottom, 0px))"
            : "14px 24px",
          borderTop:`1px solid ${C.borderLight}`,
          display:"flex", justifyContent:"flex-end", gap:10, flexShrink:0,
          background:C.ivory,
        }}>
          <button onClick={onClose} style={{
            padding:"9px 18px", borderRadius:8, cursor:"pointer",
            border:`1px solid ${C.border}`, background:C.white,
            color:C.textMid, fontSize:13.5, fontFamily:"'DM Sans',sans-serif",
            flex: isMobile ? 1 : "none",
          }}>İptal</button>
          <button onClick={onSubmit} style={{
            padding:"9px 20px", borderRadius:8, cursor:"pointer",
            border:"none",
            background: danger ? C.red : `linear-gradient(135deg,${C.navyDeep},${C.navy})`,
            color:C.white, fontSize:13.5, fontWeight:500,
            fontFamily:"'DM Sans',sans-serif",
            boxShadow:`0 2px 8px rgba(13,27,62,0.25)`,
            flex: isMobile ? 2 : "none",
          }}>{submitLabel || "Kaydet"}</button>
        </div>
      </div>
    </div>
  );
}

function FGrid({ children, cols }) {
  const { isMobile } = useBreakpoint();
  return (
    <div style={{
      display:"grid",
      gridTemplateColumns: isMobile ? "1fr" : `repeat(${cols||2}, 1fr)`,
      gap:14, marginBottom:14,
    }}>{children}</div>
  );
}

function FRow({ label, required, error, hint, children, full }) {
  return (
    <div style={{ marginBottom: full ? 14 : 0 }}>
      {label && (
        <label style={{
          display:"block", fontSize:12.5, fontWeight:500,
          color: error ? C.red : C.textMid,
          fontFamily:"'DM Sans',sans-serif", marginBottom:5,
        }}>
          {label}{required && <span style={{color:C.red, marginLeft:3}}>*</span>}
        </label>
      )}
      {children}
      {error && (
        <div style={{fontSize:11.5, color:C.red, fontFamily:"'DM Sans',sans-serif", marginTop:4}}>
          {error}
        </div>
      )}
      {hint && !error && (
        <div style={{fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:4}}>
          {hint}
        </div>
      )}
    </div>
  );
}

function FText({ value, onChange, placeholder, type, mono, error, disabled, maxLength }) {
  return (
    <input
      type={type||"text"} value={value} onChange={e=>onChange(e.target.value)}
      placeholder={placeholder} disabled={disabled} maxLength={maxLength}
      style={{
        width:"100%", boxSizing:"border-box",
        padding:"9px 12px", borderRadius:7,
        border:`1.5px solid ${error ? C.red : C.border}`,
        fontSize:13.5, color:C.text,
        fontFamily: mono ? "'DM Mono',monospace" : "'DM Sans',sans-serif",
        outline:"none", background: disabled ? C.ivory : C.white,
        transition:"border-color .15s",
      }}
      onFocus={e=>{ if(!error) e.target.style.borderColor=C.navy; }}
      onBlur={e=>{ e.target.style.borderColor=error?C.red:C.border; }}
    />
  );
}

function FSelect({ value, onChange, options, error, disabled }) {
  return (
    <select value={value} onChange={e=>onChange(e.target.value)} disabled={disabled}
      style={{
        width:"100%", boxSizing:"border-box",
        padding:"9px 12px", borderRadius:7,
        border:`1.5px solid ${error ? C.red : C.border}`,
        fontSize:13.5, color:C.text, fontFamily:"'DM Sans',sans-serif",
        outline:"none", background: disabled ? C.ivory : C.white,
        cursor: disabled ? "not-allowed" : "pointer",
        appearance:"none",
        backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 6 5-6' stroke='%236B7280' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
        backgroundRepeat:"no-repeat",
        backgroundPosition:"right 10px center",
        paddingRight:30,
      }}>
      {(options||[]).map(opt => {
        if (Array.isArray(opt)) {
          return <option key={opt[0]} value={opt[0]}>{opt[1]}</option>;
        }
        return <option key={opt} value={opt}>{opt}</option>;
      })}
    </select>
  );
}

function FTextArea({ value, onChange, placeholder, rows, error, disabled }) {
  return (
    <textarea
      value={value} onChange={e=>onChange(e.target.value)}
      placeholder={placeholder} rows={rows||3} disabled={disabled}
      style={{
        width:"100%", boxSizing:"border-box",
        padding:"9px 12px", borderRadius:7,
        border:`1.5px solid ${error ? C.red : C.border}`,
        fontSize:13.5, color:C.text, fontFamily:"'DM Sans',sans-serif",
        outline:"none", background: disabled ? C.ivory : C.white,
        resize:"vertical", lineHeight:1.55,
        transition:"border-color .15s",
      }}
      onFocus={e=>{ if(!error) e.target.style.borderColor=C.navy; }}
      onBlur={e=>{ e.target.style.borderColor=error?C.red:C.border; }}
    />
  );
}

function NotFound404({ onBack }) {
  return (
    <div style={{
      display:"flex", flexDirection:"column", alignItems:"center",
      justifyContent:"center", padding:"80px 40px", textAlign:"center", gap:16,
    }}>
      <div style={{
        fontSize:64, fontWeight:800, color:C.navyDeep, opacity:.08,
        fontFamily:"'Playfair Display',serif", lineHeight:1,
      }}>404</div>
      <div style={{marginTop:-20}}>
        <div style={{fontSize:22, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:8}}>
          Sayfa bulunamadı
        </div>
        <div style={{fontSize:14, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", maxWidth:320}}>
          Aradığınız sayfa mevcut değil ya da taşınmış olabilir.
        </div>
      </div>
      <button onClick={onBack||(() => { if(NAV_REF.fn) NAV_REF.fn('/dashboard'); })}
        style={{
          marginTop:8, padding:"10px 24px", borderRadius:9, border:"none",
          background:`linear-gradient(135deg,${C.navyDeep},${C.navy})`,
          color:C.white, fontSize:14, fontWeight:500,
          fontFamily:"'DM Sans',sans-serif", cursor:"pointer",
          boxShadow:"0 3px 12px rgba(13,27,62,0.3)",
        }}>
        Ana Sayfaya Dön
      </button>
    </div>
  );
}


/* -- useSources: loads real UUIDs from Supabase sources table ------- */
const _sourcesCache = { data: null, loading: false };
function useSources() {
  const [sources, setSources] = useState(null);
  const [srcLoading, setSrcLoading] = useState(AppConfig.useSupabase && !_sourcesCache.data);

  useEffect(() => {
    if (!AppConfig.useSupabase) { setSources(DB.sources); setSrcLoading(false); return; }
    if (_sourcesCache.data) { setSources(_sourcesCache.data); setSrcLoading(false); return; }
    if (_sourcesCache.loading) return;
    _sourcesCache.loading = true;
    const sb = getSB();
    if (!sb) { setSrcLoading(false); return; }
    sb.from("sources").select("id,name,slug,is_active").eq("is_active", true).order("name")
      .then(({ data, error }) => {
        if (!error && data) { _sourcesCache.data = data; setSources(data); }
        setSrcLoading(false);
        _sourcesCache.loading = false;
      })
      .catch(() => { setSrcLoading(false); _sourcesCache.loading = false; });
  }, []);

  const getSourceId = (label) => {
    if (!AppConfig.useSupabase) return null;
    const s = (sources || []).find(x => x.name === label || x.slug === (label||"").toLowerCase());
    return s ? s.id : null;
  };
  const sourceOptions = (sources || DB.sources).map(s => s.name || s.label || s.slug || "");
  return { sources: sources || [], srcLoading, getSourceId, sourceOptions };
}
function NewLeadModal({ onClose, onSuccess }) {
  const { isMobile } = useBreakpoint();
  const { getSourceId, sourceOptions } = useSources();
  const [name,    setName]    = useState("");
  const [phone,   setPhone]   = useState("");
  const [email,   setEmail]   = useState("");
  const [tour,    setTour]    = useState("");
  const [source,  setSource]  = useState("");
  const [adults,  setAdults]  = useState("2");
  const [date,    setDate]    = useState("");
  const [currency,setCurrency]= useState("EUR");
  const [notes,   setNotes]   = useState("");
  const [errs,    setErrs]    = useState({});
  const { mutate:mutCust } = useRepoMutation("customer");
  const { mutate:mutLead } = useRepoMutation("lead");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    const e = validate({
      name:  { required:"Ad Soyad zorunludur" },
      phone: { phone:"Geçerli bir telefon numarası girin (örn: +90 555 000 0000)" },
      email: { email:"Geçerli bir e-posta adresi girin" },
      adults:{ number:"Kişi sayısı sayısal olmalıdır", min:1, max:100 },
    }, { name, phone: phone||"0", email: email||"a@b.c", adults });
    const eReq = validate({ name:{ required:"Ad Soyad zorunludur" } }, { name });
    const ePhone = phone ? validate({ phone:{ phone:"Geçerli telefon numarası girin" } }, { phone }) : {};
    const eEmail = email ? validate({ email:{ email:"Geçerli e-posta adresi girin" } }, { email }) : {};
    const merged = { ...eReq, ...ePhone, ...eEmail };
    setErrs(merged);
    if (Object.keys(merged).length) return;

    setBusy(true);
    try {
      // ── Resolve real source UUID from Supabase (mock IDs break FK) ──
      const resolvedSourceId = getSourceId(source);

      // ── Find or create customer ─────────────────────────────────────
      let custId = null;
      if (AppConfig.useSupabase) {
        const repo = getActiveRepo('customer');
        const existing = await Promise.resolve(
          repo.findByContact({ email:email||null, phone:phone||null })
        ).catch(()=>null);
        if (existing) {
          custId = existing.id;
        } else {
          const { data:newCust, error:custErr } = await mutCust("create", {
            name, phone, email, country:"Diğer", language:"İngilizce",
            importType:"manual", sourceId: resolvedSourceId,
          });
          if (custErr) throw new Error("Müşteri oluşturulamadı: " + custErr);
          custId = newCust?.id || null;
        }
      } else {
        const nc = { id:`CUST-${Date.now()}`, name, phone, email, flag:"🌍",
          country:"Diğer", language:"İngilizce", status:"Aktif", sourceId:"SRC-01",
          initials:name.split(" ").map(w=>w[0]||"").join("").slice(0,2).toUpperCase() };
        DB.customers.push(nc);
        custId = nc.id;
      }

      // ── Create lead ─────────────────────────────────────────────────
      const { data:newLead, error } = await mutLead("create", {
        customerId: custId, name, phone, email, tour,
        paxAdult: parseInt(adults)||2, travelStart: date||null,
        currency, notes, sourceId: resolvedSourceId, importType:"manual",
      });
      if (error) throw new Error("Talep oluşturulamadı: " + error);

      showToast("Talep başarıyla oluşturuldu.");
      onSuccess && onSuccess(newLead);
      onClose();
    } catch(err) {
      console.error('[NewLeadModal] create failed:', err);
      showToast("Talep oluşturulurken bir hata oluştu: " + (err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormShell isMobile={isMobile} title="Yeni Talep Ekle" onClose={onClose} onSubmit={handleSubmit}
      submitLabel="Talebi Kaydet" submitting={busy}>
      <FGrid>
        <FRow label="Ad Soyad" required error={errs.name}>
          <FText value={name} onChange={setName} placeholder="Sarah Johnson" error={errs.name}/>
        </FRow>
        <FRow label="Kaynak">
          <FSelect value={source} onChange={setSource} options={sourceOptions}/>
        </FRow>
        <FRow label="Telefon" error={errs.phone}>
          <FText value={phone} onChange={setPhone} placeholder="+90 555 000 0000" mono error={errs.phone}/>
        </FRow>
        <FRow label="E-posta" error={errs.email}>
          <FText value={email} onChange={setEmail} placeholder="email@example.com" type="email" error={errs.email}/>
        </FRow>
      </FGrid>
      <FRow label="Tur / Destinasyon" full>
        <FText value={tour} onChange={setTour} placeholder="Private Istanbul Experience"/>
      </FRow>
      <FGrid>
        <FRow label="Kişi Sayısı" error={errs.adults}>
          <FText value={adults} onChange={setAdults} placeholder="2" mono error={errs.adults}/>
        </FRow>
        <FRow label="Seyahat Tarihi (yaklaşık)">
          <FText value={date} onChange={setDate} placeholder="2026-07-15" mono/>
        </FRow>
        <FRow label="Para Birimi">
          <FSelect value={currency} onChange={setCurrency} options={["EUR","USD","GBP","TRY"]}/>
        </FRow>
      </FGrid>
      <FRow label="Notlar" full>
        <FTextArea value={notes} onChange={setNotes} placeholder="Müşteri hakkında ekstra bilgi…"/>
      </FRow>
    </FormShell>
  );
}

function NewTourModal({ onClose }) {
  const [name,     setName]     = useState("");
  const [category, setCategory] = useState("Kültür & Tarih");
  const [duration, setDuration] = useState("1");
  const [price,    setPrice]    = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [desc,     setDesc]     = useState("");
  const [errs,     setErrs]     = useState({});
  const { mutate:mutTour, mutating:tourMut } = useRepoMutation("tour");

  async function handleSubmit() {
    const e = validate({
      name:  { required:"Tur adı zorunludur", minLen:3 },
      price: { required:"Fiyat zorunludur", number:"Sayısal bir fiyat girin", min:1 },
    }, { name, price });
    setErrs(e);
    if (Object.keys(e).length) return;
    const { error } = await mutTour("create", {
      name, category, duration:parseInt(duration)||1,
      flatPrice:parseFloat(price)||0, currency, description:desc,
    });
    if (error) { showToast("Tur oluşturulamadı ✗"); return; }
    showToast("Tur oluşturuldu ✓"); onClose();
  }

  return (
    <Modal title="Yeni Tur Ekle" onClose={onClose} onSubmit={handleSubmit}
      submitLabel={tourMut?"Kaydediliyor…":"Turu Kaydet"}>
      <FRow label="Tur Adı" required error={errs.name} full>
        <FText value={name} onChange={setName} placeholder="Private Istanbul Experience" error={errs.name}/>
      </FRow>
      <FGrid>
        <FRow label="Kategori">
          <FSelect value={category} onChange={setCategory}
            options={["Kültür & Tarih","Gastronomi","Macera","Doğa","VIP","Aile"]}/>
        </FRow>
        <FRow label="Süre (gün)">
          <FText value={duration} onChange={setDuration} placeholder="1" mono/>
        </FRow>
        <FRow label="Fiyat" required error={errs.price}>
          <FText value={price} onChange={setPrice} placeholder="350.00" mono error={errs.price}/>
        </FRow>
        <FRow label="Para Birimi">
          <FSelect value={currency} onChange={setCurrency} options={["EUR","USD","GBP","TRY"]}/>
        </FRow>
      </FGrid>
      <FRow label="Açıklama" full>
        <FTextArea value={desc} onChange={setDesc} placeholder="Tur hakkında kısa açıklama…" rows={3}/>
      </FRow>
    </Modal>
  );
}

const _QS_DB  = { 'Taslak':'draft','Gönderildi':'sent','Onaylandı':'approved','İptal':'rejected','Süresi Doldu':'expired' };
const _QS_APP = { 'draft':'Taslak','sent':'Gönderildi','approved':'Onaylandı','rejected':'İptal','expired':'Süresi Doldu' };
const _QI_TYPE_DB  = { 'Dahil':'included','Hariç':'excluded','Fiyat':'pricing','Not':'note' };
const _QI_TYPE_APP = { 'included':'Dahil','excluded':'Hariç','pricing':'Fiyat','note':'Not' };

function mapQuoteFromDB(r, items) {
  if (!r) return null;
  const total    = parseFloat(r.total_amount  || 0);
  const deposit  = parseFloat(r.deposit_amount || 0);
  const discount = parseFloat(r.discount_amount || 0);
  const pax      = parseInt(r.guest_count || 1);
  const unitPrice= pax > 0 ? Math.round((total + discount) / pax) : 0;
  return {
    id:            r.id,
    quoteNumber:   r.quote_number || r.id,
    leadId:        r.lead_id       || null,
    customerId:    r.customer_id   || null,
    tourId:        r.tour_id       || null,
    // Real Supabase rows never had this field, only mock data did — every
    // consumer (QuotesPage's search filter, QuoteDetailPage) calls
    // .toLowerCase() / renders it directly as a string, so a missing
    // value here was a hard crash in Supabase mode, not just a blank cell.
    customer:      r.customer?.full_name || '',
    flag:          r.flag || '🌍',
    tour:          r.tour_name || (r.lead && r.lead.destination) || r.destination || '—',
    dateRange:     r.travel_start_date
      ? new Date(r.travel_start_date).toLocaleDateString('tr-TR',{day:'2-digit',month:'short',year:'numeric'})
      : '—',
    travelStart:   r.travel_start_date || null,
    pax,
    unitPrice,
    total,
    deposit,
    remaining:     total - deposit,
    discountAmount:discount,
    discountPct:   total+discount > 0 ? Math.round(discount/(total+discount)*100) : 0,
    currency:      r.currency     || 'EUR',
    status:        _QS_APP[r.status] || r.status || 'Taslak',
    validUntil:    r.valid_until   || null,
    notes:         r.notes         || '',
    assigneeId:    r.assigned_to   || null,
    createdAt:     r.created_at    ? r.created_at.split('T')[0] : '',
    items:         (items || []).map(mapQuoteItemFromDB),
    _fromDB:       true,
  };
}

function mapQuoteItemFromDB(r) {
  if (!r) return null;
  return {
    id:         r.id,
    quoteId:    r.quote_id,
    type:       _QI_TYPE_APP[r.item_type] || r.item_type || 'Dahil',
    label:      r.description || '',
    quantity:   parseInt(r.quantity   || 1),
    unitPrice:  parseFloat(r.unit_price || 0),
    total:      parseFloat(r.total_price || 0),
    sortOrder:  r.sort_order || 0,
    tourId:     r.tour_id   || null,
    _fromDB:    true,
  };
}

const SupabaseQuoteRepo = {
  async getAll(filters = {}) {
    const sb = getSB();
    if (!sb) return QuoteRepository.getAll(filters);

    let q = sb.from('quotes')
      .select(`
        *,
        customer:customers(id,full_name,email,phone),
        lead:leads(id,lead_number,destination)
      `)
      .order('created_at', { ascending: false });
    /* NOTE: quotes has no tour_id FK — tour name comes from leads.destination */

    if (filters.status)     q = q.eq('status', _QS_DB[filters.status] || filters.status);
    if (filters.customerId) q = q.eq('customer_id', filters.customerId);
    if (filters.leadId)     q = q.eq('lead_id', filters.leadId);
    if (filters.search)     q = q.or(`quote_number.ilike.%${filters.search}%`);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    return (data || []).map(r => mapQuoteFromDB({
      ...r,
      tour_name: r.tour?.name || r.destination || '—',
    }, []));
  },

  async getById(id) {
    const sb = getSB();
    if (!sb) return QuoteRepository.getById(id);

    const [{ data: q, error: qErr }, { data: items, error: iErr }] = await Promise.all([
      sb.from('quotes')
        .select(`*, customer:customers(*), lead:leads(*)`)
        .eq('id', id)
        .maybeSingle(),
      sb.from('quote_items')
        .select('*')
        .eq('quote_id', id)
        .order('sort_order'),
    ]);

    if (qErr) throw new Error(qErr.message);
    if (!q)   return null;
    return mapQuoteFromDB({ ...q, tour_name: q.tour?.name || q.destination || '—' }, items || []);
  },

  async getByCustomerId(customerId) {
    const sb = getSB();
    if (!sb) return QuoteRepository.getByCustomerId(customerId);
    const { data, error } = await sb.from('quotes')
      .select('*, lead:leads(id,destination)')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map(r => mapQuoteFromDB({ ...r, tour_name: r.tour?.name || '—' }, []));
  },

  async create(data) {
    const sb = getSB();
    if (!sb) return QuoteRepository.create(data);

    let qNum = `Q-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
    try {
      const { data: ref } = await sb.rpc('next_ref_number', {
        prefix: 'Q', table_name: 'quotes', number_col: 'quote_number',
      });
      if (ref) qNum = ref;
    } catch (_) {}

    const pax     = parseInt(data.guestCount || data.pax || 1);
    const unit    = parseFloat(data.pricePerPerson || data.unitPrice || 0);
    const disc    = parseFloat(data.discountAmount || 0);
    const discPct = parseFloat(data.discountPct || 0);
    const total   = data.total
      ? parseFloat(data.total)
      : Math.round(unit * pax * (1 - discPct / 100));
    const deposit = data.deposit ? parseFloat(data.deposit) : Math.round(total * 0.25);

    const row = {
      quote_number:    qNum,
      lead_id:         data.leadId      || null,
      customer_id:     data.customerId  || null,
      /* tour_id does NOT exist in quotes table — use destination text instead */
      destination:     data.tourName    || data.tour || null,
      status:          _QS_DB[data.status] || 'draft',
      currency:        data.currency    || 'EUR',
      guest_count:     pax,
      subtotal:        total + disc,
      discount_amount: disc || Math.round((unit * pax * discPct) / 100),
      total_amount:    total,
      deposit_amount:  deposit,
      tax_rate:        0,
      tax_amount:      0,
      travel_start_date: data.travelStart || data.tourDate || null,
      valid_until:     data.validUntil   || null,
      notes:           data.notes        || null,
      assigned_to:     data.assigneeId   || null,
      created_by:      data.createdBy    || null,
    };

    const { data: created, error } = await sb.from('quotes').insert(row).select().single();
    if (error) throw new Error(error.message);

    if (data.items && data.items.length > 0) {
      const itemRows = data.items.map((item, i) => ({
        quote_id:    created.id,
        tour_id:     item.tourId || null,
        item_type:   _QI_TYPE_DB[item.type] || 'included',
        description: item.label || item.description,
        quantity:    parseInt(item.quantity || 1),
        unit_price:  parseFloat(item.unitPrice || 0),
        total_price: parseFloat(item.total || item.unitPrice || 0),
        currency:    data.currency || 'EUR',
        sort_order:  i,
      }));
      await sb.from('quote_items').insert(itemRows);
    }

    await _sbLog('quote', created.id, 'created', `Teklif oluşturuldu: ${created.quote_number}`);
    return mapQuoteFromDB({ ...created, tour_name: data.tourName || data.tour || '—' }, data.items || []);
  },

  async update(id, patch) {
    const sb = getSB();
    if (!sb) return QuoteRepository.update(id, patch);

    const row = {};
    if (patch.status     !== undefined) row.status       = _QS_DB[patch.status] || patch.status;
    if (patch.notes      !== undefined) row.notes        = patch.notes;
    if (patch.validUntil !== undefined) row.valid_until  = patch.validUntil;
    if (patch.total      !== undefined) row.total_amount = patch.total;
    if (patch.deposit    !== undefined) row.deposit_amount = patch.deposit;
    if (patch.assigneeId !== undefined) row.assigned_to  = patch.assigneeId;

    const { data: updated, error } = await sb.from('quotes').update(row).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    if (patch.status) await _sbLog('quote', id, 'status_changed', `Durum → ${patch.status}`);
    return mapQuoteFromDB(updated, []);
  },

  async delete(id) {
    const sb = getSB();
    if (!sb) return QuoteRepository.delete(id);
    const { error } = await sb.from('quotes').update({ status: 'rejected' }).eq('id', id);
    if (error) throw new Error(error.message);
    return true;
  },
};

function mapTourFromDB(r) {
  if (!r) return null;
  const s = { 'active':'Aktif', 'draft':'Taslak', 'archived':'Arşiv' };
  return {
    id:          r.id,
    name:        r.name          || '',
    category:    r.category      || 'Diğer',
    duration:    r.duration_days || 1,
    status:      s[r.status]     || r.status || 'Aktif',
    flatPrice:   parseFloat(r.flat_price || 0),
    currency:    r.currency      || 'EUR',
    description: r.description   || '',
    pricingType: r.pricing_type  || 'flat',
    isActive:    r.is_active     !== false,
    usageCount:  r.usage_count   || 0,
    createdAt:   r.created_at    ? r.created_at.split('T')[0] : '',
    updatedAt:   r.updated_at    ? r.updated_at.split('T')[0] : '',
    _fromDB:     true,
  };
}

const SupabaseTourRepo = {
  async getAll(f = {}) {
    const sb = getSB();
    if (!sb) return TourRepository.getAll(f);
    let q = sb.from('tours').select('*').order('name');
    if (f.status && f.status !== 'Tümü') {
      const dbS = f.status === 'Aktif' ? 'active' : f.status === 'Taslak' ? 'draft' : 'archived';
      q = q.eq('status', dbS);
    } else {
      q = q.in('status', ['active','draft']);
    }
    if (f.search) q = q.ilike('name', `%${f.search}%`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data || []).map(mapTourFromDB);
  },

  async getById(id) {
    const sb = getSB();
    if (!sb) return TourRepository.getById(id);
    const { data, error } = await sb.from('tours').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return mapTourFromDB(data);
  },

  async create(d) {
    const sb = getSB();
    if (!sb) return TourRepository.create(d);
    const { data: c, error } = await sb.from('tours').insert({
      name: d.name, category: d.category || 'Diğer',
      duration_days: parseInt(d.duration || 1),
      flat_price: parseFloat(d.flatPrice || d.price || 0),
      currency: d.currency || 'EUR',
      description: d.description || null,
      status: 'active', is_active: true, pricing_type: 'flat',
    }).select().single();
    if (error) throw new Error(error.message);
    await _sbLog('tour', c.id, 'created', `Tur oluşturuldu: ${c.name}`);
    return mapTourFromDB(c);
  },

  async update(id, d) {
    const sb = getSB();
    if (!sb) return TourRepository.update(id, d);
    const dbS = d.status === 'Aktif' ? 'active' : d.status === 'Taslak' ? 'draft' : d.status === 'Arşiv' ? 'archived' : undefined;
    const row = {};
    if (d.name        !== undefined) row.name          = d.name;
    if (d.category    !== undefined) row.category      = d.category;
    if (d.duration    !== undefined) row.duration_days = parseInt(d.duration);
    if (d.flatPrice   !== undefined) row.flat_price    = parseFloat(d.flatPrice);
    if (d.currency    !== undefined) row.currency      = d.currency;
    if (d.description !== undefined) row.description   = d.description;
    if (d.status      !== undefined) row.status        = dbS || d.status;
    if (d.pricingType !== undefined) row.pricing_type  = d.pricingType;
    const { data: u, error } = await sb.from('tours').update(row).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    await _sbLog('tour', id, 'updated', `Tur güncellendi: ${u.name}`);
    return mapTourFromDB(u);
  },
};

const SupabaseStaffRepo = {
  async getAll() {
    const sb = getSB();
    if (!sb) return DB.staff;
    const { data, error } = await sb.from('staff_users')
      .select('id, full_name, email, role, is_active')
      .order('full_name');
    if (error) throw new Error(error.message);
    return (data || []).map(r => ({
      id: r.id, name: r.full_name, full_name: r.full_name,
      email: r.email, role: r.role === 'admin' ? 'Yönetici'
        : r.role === 'sales' ? 'Satış'
        : r.role === 'operations' ? 'Operasyon'
        : r.role === 'guide' ? 'Rehber' : r.role,
      active: r.is_active !== false,
      initials: (r.full_name || '?').split(' ').map(w => w[0] || '').join('').slice(0,2).toUpperCase(),
    }));
  },
};

const EmailService = {
  _provider: null,

  setProvider(provider) { this._provider = provider; },

  get provider() {
    return this._provider || MockEmailProvider;
  },

  async sendProposal({ quote, customer, recipientEmail, pdfBlob }) {
    return this.provider.sendProposal({ quote, customer, recipientEmail, pdfBlob });
  },
  async sendReminder({ quote, customer, recipientEmail }) {
    return this.provider.sendReminder({ quote, customer, recipientEmail });
  },
  async sendReviewRequest({ reservation, customer, recipientEmail }) {
    return this.provider.sendReviewRequest({ reservation, customer, recipientEmail });
  },
};

const MockEmailProvider = {
  name: 'mock',

  async sendProposal({ quote, customer, recipientEmail, attachment }) {
    if (AppConfig.useResend === false || !AppConfig.useResend) {
      console.info('[MockEmail] sendProposal (MOCK MODE)', {
        to:          recipientEmail,
        quoteId:     quote?.id || quote?.quoteNumber,
        hasAttachment: !!attachment,
        attachmentFile: attachment?.filename || null,
        note: 'No real email sent. Set USE_RESEND=true to activate Resend.',
      });
    }
    await new Promise(r => setTimeout(r, 700));
    return {
      success:    true,
      messageId:  `mock-${Date.now()}`,
      provider:   'mock',
      attachment: !!attachment,
    };
  },
  async sendReminder({ quote, customer, recipientEmail }) {
    console.info(`[MockEmail] sendReminder → ${recipientEmail}`);
    return { success: true, messageId: `mock-${Date.now()}`, provider: 'mock' };
  },
  async sendReviewRequest({ reservation, customer, recipientEmail }) {
    console.info(`[MockEmail] sendReviewRequest → ${recipientEmail}`);
    return { success: true, messageId: `mock-${Date.now()}`, provider: 'mock' };
  },
};

const ResendEmailProvider = {
  name: 'resend',

  _buildHtml({ proposalData, quoteNumber, recipientEmail }) {
    const { guest, tour, pricing, notes, validUntil } = proposalData;
    const { fmt, total, deposit, remaining, currency } = pricing;
    const sym = currency === 'TRY' ? '₺' : '€';

    return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Dese Tour — Özel Teklif ${quoteNumber}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700&family=DM+Sans:wght@300;400;500;600&display=swap');
    body { margin:0; padding:0; background:#EDE9DF; font-family:'DM Sans',Helvetica,Arial,sans-serif; color:#1B2D4F; }
    .wrapper { max-width:600px; margin:32px auto; background:#FFFFFF; border-radius:12px; overflow:hidden; box-shadow:0 8px 32px rgba(13,27,62,0.12); }
    .top-bar { height:4px; background:linear-gradient(90deg,#1B2D4F,#C9A84C); }
    .header { padding:32px 40px 24px; background:#1B2D4F; }
    .logo-name { font-family:'Playfair Display',Georgia,serif; font-size:24px; font-weight:700; color:#FAF7F2; letter-spacing:-0.01em; }
    .logo-sub { font-size:10px; letter-spacing:0.14em; text-transform:uppercase; color:rgba(201,168,76,0.75); margin-top:2px; }
    .quote-meta { text-align:right; }
    .quote-label { font-size:18px; font-weight:700; font-family:'Playfair Display',Georgia,serif; color:#FAF7F2; }
    .quote-num { font-size:12px; color:rgba(248,245,238,0.55); margin-top:4px; }
    .body { padding:36px 40px; }
    .greeting { font-size:22px; font-weight:700; font-family:'Playfair Display',Georgia,serif; color:#1B2D4F; margin-bottom:4px; }
    .greeting-sub { font-size:13.5px; color:#8A7F72; line-height:1.6; margin-bottom:28px; }
    .section-title { font-size:9.5px; letter-spacing:0.13em; text-transform:uppercase; color:#8A7F72; font-weight:600; margin-bottom:12px; }
    .info-card { background:#FAF7F2; border-radius:10px; padding:18px 22px; margin-bottom:20px; border-left:3px solid #C9A84C; }
    .info-row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #E8E2D9; font-size:13px; }
    .info-row:last-child { border-bottom:none; }
    .info-label { color:#8A7F72; font-size:11px; text-transform:uppercase; letter-spacing:0.09em; }
    .info-val { color:#1B2D4F; font-weight:500; }
    .pricing-block { background:#1B2D4F; border-radius:10px; padding:22px 26px; margin:24px 0; color:#fff; }
    .pricing-row { display:flex; justify-content:space-between; padding:7px 0; font-size:13.5px; border-bottom:1px solid rgba(255,255,255,0.08); }
    .pricing-row:last-child { border-bottom:none; }
    .pricing-label { color:rgba(255,255,255,0.6); }
    .pricing-val { font-weight:500; }
    .total-row { display:flex; justify-content:space-between; margin-top:14px; padding-top:14px; border-top:1px solid rgba(255,255,255,0.15); }
    .total-label { font-size:12px; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:0.1em; }
    .total-val { font-size:28px; font-weight:700; font-family:'Playfair Display',Georgia,serif; }
    .deposit-row { display:flex; gap:32px; margin-top:10px; }
    .deposit-item { }
    .deposit-label { font-size:9.5px; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:3px; }
    .deposit-val { font-size:15px; font-weight:600; color:#C9A84C; }
    .remaining-val { font-size:15px; font-weight:600; color:rgba(255,255,255,0.8); }
    .notes-block { background:#F5F1EA; border-radius:8px; padding:14px 18px; margin:16px 0; font-size:13px; line-height:1.7; color:#4A4038; }
    .cta-block { text-align:center; margin:28px 0 8px; }
    .cta-btn { display:inline-block; padding:13px 32px; background:linear-gradient(135deg,#1B2D4F,#2C3E6B); color:#fff; text-decoration:none; border-radius:9px; font-size:14px; font-weight:600; letter-spacing:0.02em; }
    .footer { background:#F5F1EA; padding:24px 40px; border-top:1px solid #E8E2D9; text-align:center; }
    .footer-name { font-size:13px; font-weight:600; color:#1B2D4F; margin-bottom:4px; }
    .footer-info { font-size:12px; color:#8A7F72; line-height:1.8; }
    .footer-link { color:#C9A84C; text-decoration:none; }
    .bottom-bar { height:2px; background:linear-gradient(90deg,#C9A84C,#1B2D4F); }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="top-bar"></div>
  <div class="header">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="logo-name">Dese Tour</div>
        <div class="logo-sub">Private Experience Specialists</div>
      </div>
      <div class="quote-meta">
        <div class="quote-label">Özel Seyahat Teklifi</div>
        <div class="quote-num">Teklif No: ${quoteNumber}</div>
      </div>
    </div>
  </div>
  <div class="body">
    <div class="greeting">Sayın ${guest.name}</div>
    <div class="greeting-sub">
      İstanbul'un eşsiz güzelliklerinde sizi ağırlamaktan büyük mutluluk duyacağız.
      Aşağıda sizin için özenle hazırladığımız özel deneyim teklifini bulabilirsiniz.
    </div>

    <div class="section-title">Deneyim Bilgileri</div>
    <div class="info-card">
      <div class="info-row"><span class="info-label">Tur</span><span class="info-val">${tour.name}</span></div>
      <div class="info-row"><span class="info-label">Tarih</span><span class="info-val">${tour.date}</span></div>
      <div class="info-row"><span class="info-label">Süre</span><span class="info-val">${tour.duration}</span></div>
      <div class="info-row"><span class="info-label">Misafir Sayısı</span><span class="info-val">${guest.pax} Kişi</span></div>
      <div class="info-row"><span class="info-label">Karşılama</span><span class="info-val">${tour.pickup}</span></div>
    </div>

    <div class="section-title">Fiyatlandırma</div>
    <div class="pricing-block">
      <div class="pricing-row"><span class="pricing-label">Kişi Başı</span><span class="pricing-val">${pricing.unitPrice > 0 ? fmt(pricing.unitPrice) : '—'}</span></div>
      <div class="pricing-row"><span class="pricing-label">Kişi Sayısı</span><span class="pricing-val">${guest.pax} kişi</span></div>
      ${pricing.discountPct > 0 ? `<div class="pricing-row"><span class="pricing-label">İndirim</span><span class="pricing-val">%${pricing.discountPct}</span></div>` : ''}
      <div class="total-row">
        <span class="total-label">Toplam</span>
        <span class="total-val">${fmt(total)}</span>
      </div>
      <div class="deposit-row">
        <div class="deposit-item"><div class="deposit-label">Kapora</div><div class="deposit-val">${fmt(deposit)}</div></div>
        <div class="deposit-item"><div class="deposit-label">Kalan Bakiye</div><div class="remaining-val">${fmt(remaining)}</div></div>
      </div>
    </div>

    ${notes ? `<div class="section-title">Özel Notlar</div><div class="notes-block">${notes}</div>` : ''}
    ${validUntil ? `<p style="font-size:12px;color:#8A7F72;margin:8px 0">Bu teklif <strong>${validUntil}</strong> tarihine kadar geçerlidir.</p>` : ''}

    <div class="cta-block">
      <a href="mailto:${AppConfig.fromEmail}" class="cta-btn">Rezervasyonu Onaylayın</a>
    </div>
  </div>
  <div class="footer">
    <div class="footer-name">Dese Tour Operations</div>
    <div class="footer-info">
      <a href="mailto:${AppConfig.fromEmail}" class="footer-link">${AppConfig.fromEmail}</a> ·
      <a href="https://www.desetour.com" class="footer-link">www.desetour.com</a><br/>
      Istanbul, Türkiye · +90 555 123 45 67
    </div>
  </div>
  <div class="bottom-bar"></div>
</div>
</body>
</html>`;
  },

  async sendProposal({ quote, customer, recipientEmail }) {
    const proposalData = buildProposalData(quote, customer);
    const email = recipientEmail
      || customer?.email
      || quote?.guest?.email
      || '';

    if (!email) {
      return { success: false, error: 'E-posta adresi bulunamadı.', provider: 'resend' };
    }

    const quoteNumber = quote?.quoteNumber || quote?.id || '?';
    const subject     = `Dese Tour — Özel Seyahat Teklifiniz (${quoteNumber})`;
    const html        = this._buildHtml({ proposalData, quoteNumber, recipientEmail: email });

    let attachment = null;
    try {
      const pdfResult = await PDFService.generateFromData(proposalData, quoteNumber);
      attachment = PDFService.buildAttachment(pdfResult);
      if (!AppConfig.useResend) console.info('[ResendEmailProvider] PDF generated:', {
        filename: attachment.filename,
        sizeKB:   Math.round(attachment.content.length * 0.75 / 1024),
      });
    } catch (pdfErr) {
      console.warn('[ResendEmailProvider] PDF generation failed (non-fatal):', pdfErr.message);
    }

    try {
      const body = {
        to:      email,
        subject,
        html,
        metadata: {
          quoteId:       quote?.id,
          customerId:    customer?.id || quote?.customerId,
          type:          'proposal',
          hasAttachment: !!attachment,
        },
      };

      if (attachment) {
        body.attachments = [{
          filename:    attachment.filename,
          content:     attachment.content,     // base64
          contentType: attachment.contentType, // application/pdf
        }];
      }

      const res  = await fetch(AppConfig.emailEndpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      return {
        success:       true,
        messageId:     data.id,
        provider:      'resend',
        hasAttachment: !!attachment,
        attachmentFile: attachment?.filename || null,
      };

    } catch (err) {
      console.error('[ResendEmailProvider] sendProposal failed:', err.message);
      return { success: false, error: err.message, provider: 'resend' };
    }
  },

  async sendReminder({ quote, customer, recipientEmail }) {
    const email = recipientEmail || customer?.email || '';
    if (!email) return { success: false, error: 'E-posta adresi bulunamadı.' };

    const sym   = (quote?.currency || 'EUR') === 'TRY' ? '₺' : '€';
    const subject = `Dese Tour — Ödeme Hatırlatması`;
    const html = `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden">
      <div style="height:4px;background:linear-gradient(90deg,#1B2D4F,#C9A84C)"></div>
      <div style="padding:32px 36px">
        <h2 style="color:#1B2D4F;font-family:Georgia,serif;margin-top:0">Ödeme Hatırlatması</h2>
        <p style="color:#4A5568;line-height:1.7">Sayın ${customer?.name || 'Misafirimiz'},</p>
        <p style="color:#4A5568;line-height:1.7">
          ${quote?.tour || 'Turunuz'} için kalan bakiyenizi hatırlatmak istedik.
          Rezervasyonunuzu tamamlamak için aşağıdaki bilgileri kullanabilirsiniz.
        </p>
        <div style="background:#FAF7F2;border-radius:8px;padding:16px 20px;border-left:3px solid #C9A84C">
          <div style="font-size:13px;color:#8A7F72;margin-bottom:4px">Kalan Tutar</div>
          <div style="font-size:24px;font-weight:700;color:#1B2D4F">${sym}${Number(quote?.remaining||0).toLocaleString()}</div>
        </div>
        <p style="color:#8A7F72;font-size:12px;margin-top:20px">
          Herhangi bir sorunuz için bize ulaşmaktan çekinmeyin.
        </p>
      </div>
    </div>`;

    try {
      const res = await fetch(AppConfig.emailEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: email, subject, html,
          metadata: { quoteId: quote?.id, type: 'reminder' } }),
      });
      const data = await res.json();
      return { success: res.ok, messageId: data.id, provider: 'resend' };
    } catch (err) {
      return { success: false, error: err.message, provider: 'resend' };
    }
  },

  async sendReviewRequest({ reservation, customer, recipientEmail }) {
    const email = recipientEmail || customer?.email || '';
    if (!email) return { success: false, error: 'E-posta adresi bulunamadı.' };

    const subject = `Dese Tour — Deneyiminizi Değerlendirin`;
    const html = `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto">
      <h2 style="color:#1B2D4F;font-family:Georgia,serif">${customer?.name || 'Sayın Misafirimiz'},</h2>
      <p style="color:#4A5568;line-height:1.7">
        ${reservation?.tour || 'Tur'} deneyiminizi nasıl buldunuz? Değerlendirmeniz bizim için çok değerli.
      </p>
      <p style="margin-top:24px">
        <a href="https://www.tripadvisor.com/desetour" style="padding:12px 28px;background:#1B2D4F;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">
          Değerlendirme Yaz
        </a>
      </p>
    </div>`;

    try {
      const res = await fetch(AppConfig.emailEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: email, subject, html,
          metadata: { reservationId: reservation?.id, type: 'review' } }),
      });
      const data = await res.json();
      return { success: res.ok, messageId: data.id, provider: 'resend' };
    } catch (err) {
      return { success: false, error: err.message, provider: 'resend' };
    }
  },
};

(function() {
  if (AppConfig.useResend) {
    EmailService.setProvider(ResendEmailProvider);
    console.info('[EmailService] Provider: Resend → ', AppConfig.emailEndpoint);
  } else {
    console.info('[EmailService] Provider: Mock (set USE_RESEND=true to activate Resend)');
  }
})();

function buildProposalData(q, customer) {
  const cust = customer || getCustomerById(q?.customerId) || {};
  const sym  = (q?.currency || 'EUR') === 'TRY' ? '₺' : '€';
  const fmt  = n => `${sym}${Number(n||0).toLocaleString('tr-TR', { minimumFractionDigits:0, maximumFractionDigits:0 })}`;

  const included = (q?.items || [])
    .filter(i => i.type === 'Dahil')
    .map(i => i.label)
    .filter(Boolean);

  const excluded = (q?.items || [])
    .filter(i => i.type === 'Hariç')
    .map(i => i.label)
    .filter(Boolean);

  const incFallback = ['Profesyonel rehber eşliği', 'Özel araç transferi', 'Tüm giriş ücretleri', 'Geleneksel Türk kahvaltısı'];
  const excFallback = ['Uçuş ve vize', 'Kişisel harcamalar'];

  return {
    quoteNumber: q?.quoteNumber || q?.id || '—',
    date: new Date().toLocaleDateString('tr-TR', { day:'2-digit', month:'long', year:'numeric' }),
    guest: {
      name:    cust.name     || q?.customer || 'Değerli Misafirimiz',
      country: cust.country  || cust.nationality || '',
      flag:    cust.flag     || '🌍',
      pax:     q?.pax        || 1,
      email:   cust.email    || '',
      phone:   cust.phone    || '',
    },
    tour: {
      name:     q?.tour      || '—',
      date:     q?.dateRange || q?.travelStart || '—',
      duration: q?.duration  || '1 gün',
      pickup:   q?.pickup    || 'Otel Karşılama',
    },
    included: included.length ? included : incFallback,
    excluded: excluded.length ? excluded : excFallback,
    pricing: {
      sym,
      fmt,
      unitPrice:  Number(q?.unitPrice  || 0),
      pax:        Number(q?.pax        || 1),
      discountPct:Number(q?.discountPct|| 0),
      total:      Number(q?.total      || 0),
      deposit:    Number(q?.deposit    || 0),
      remaining:  Number(q?.remaining  || (q?.total||0) - (q?.deposit||0)),
      currency:   q?.currency || 'EUR',
    },
    notes: q?.notes || '',
    validUntil: q?.validUntil || '',
    status: q?.status || 'Taslak',
  };
}

function ProposalTemplate({ data, compact }) {
  const { guest, tour, included, excluded, pricing, notes, validUntil, quoteNumber, date, status } = data;
  const { sym, fmt, unitPrice, pax, discountPct, total, deposit, remaining } = pricing;

  const NAV  = '#1B2D4F';  // deep navy
  const GOLD = '#C9A84C';  // warm gold
  const IVO  = '#FAF7F2';  // ivory bg
  const MUT  = '#8A7F72';  // muted text
  const LINE = '#E8E2D9';  // line color
  const GRN  = '#2E7D52';  // green

  const sectionTitle = (title) => (
    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
      <div style={{ height:1, background:LINE, flex:1 }}/>
      <span style={{ fontSize:9, letterSpacing:'0.14em', textTransform:'uppercase',
        color:MUT, fontFamily:"'DM Sans',sans-serif", fontWeight:600, whiteSpace:'nowrap' }}>
        {title}
      </span>
      <div style={{ height:1, background:LINE, flex:1 }}/>
    </div>
  );

  return (
    <div id="proposal-template" style={{
      width:700, margin:'0 auto',
      background:'#FFFFFF',
      fontFamily:"'DM Sans',sans-serif",
      color:NAV,
      padding:compact ? '28px 36px' : '36px 48px',
      boxSizing:'border-box',
      position:'relative',
    }}>

      {}
      <div style={{ height:4, background:`linear-gradient(90deg,${NAV},${GOLD})`,
        margin: compact ? '-28px -36px 28px' : '-36px -48px 36px' }}/>

      {}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:28 }}>
        {}
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
            <div style={{ flexShrink:0 }}>
              <img src="/seffafdeselogo.png" alt="Dese Tour"
                style={{ height:40, width:'auto' }}
              />
            </div>
            <div>
              <div style={{ fontSize:9.5, color:MUT, letterSpacing:'0.12em', textTransform:'uppercase', fontWeight:600 }}>
                Private Experience Specialists
              </div>
            </div>
          </div>
        </div>

        {}
        <div style={{ textAlign:'right' }}>
          <div style={{ fontSize:20, fontWeight:700, fontFamily:"'Playfair Display',serif", color:NAV, marginBottom:3 }}>
            Özel Seyahat Teklifi
          </div>
          <div style={{ fontSize:11.5, color:MUT, marginBottom:2 }}>
            Teklif No: <strong style={{color:NAV}}>{quoteNumber}</strong>
          </div>
          <div style={{ fontSize:11, color:MUT }}>Tarih: {date}</div>
          {validUntil && (
            <div style={{ fontSize:10.5, color:GOLD, marginTop:3, fontWeight:500 }}>
              Geçerlilik: {validUntil} tarihine kadar
            </div>
          )}
        </div>
      </div>

      {}
      <div style={{ background:IVO, borderRadius:10, padding:'16px 20px', marginBottom:24,
        borderLeft:`3px solid ${GOLD}` }}>
        <div style={{ fontSize:11, color:MUT, letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:4 }}>
          Sayın Misafirimiz
        </div>
        <div style={{ fontSize:17, fontWeight:600, fontFamily:"'Playfair Display',serif", color:NAV, marginBottom:6 }}>
          {guest.name}
          {guest.country && (
            <span style={{ fontSize:13, fontWeight:400, color:MUT, marginLeft:10 }}>
              {guest.flag} {guest.country}
            </span>
          )}
        </div>
        <div style={{ fontSize:12, color:MUT, lineHeight:1.6 }}>
          Dese Tour olarak sizi İstanbul'un eşsiz güzelliklerinde ağırlamaktan büyük mutluluk duyacağız.
          Aşağıda sizin için özel olarak hazırladığımız deneyim teklifini bulabilirsiniz.
        </div>
      </div>

      {}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:24 }}>
        {}
        <div style={{ border:`1px solid ${LINE}`, borderRadius:10, padding:'14px 16px' }}>
          {sectionTitle('Deneyim')}
          <div style={{ fontSize:15, fontWeight:600, fontFamily:"'Playfair Display',serif", color:NAV, marginBottom:10, lineHeight:1.3 }}>
            {tour.name}
          </div>
          {[
            { label:'Tarih',    val:tour.date },
            { label:'Süre',     val:tour.duration },
            { label:'Misafir',  val:`${guest.pax} Kişi` },
            { label:'Karşılama',val:tour.pickup },
          ].map(({ label, val }) => (
            <div key={label} style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
              padding:'5px 0', borderBottom:`1px solid ${LINE}` }}>
              <span style={{ fontSize:11, color:MUT, textTransform:'uppercase', letterSpacing:'0.08em' }}>{label}</span>
              <span style={{ fontSize:12.5, color:NAV, fontWeight:500 }}>{val || '—'}</span>
            </div>
          ))}
        </div>

        {}
        <div style={{ border:`1px solid ${LINE}`, borderRadius:10, padding:'14px 16px' }}>
          {sectionTitle('Dahil Hizmetler')}
          <div style={{ display:'flex', flexDirection:'column', gap:5, marginBottom:12 }}>
            {included.slice(0,5).map((s, i) => (
              <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:7 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={GRN}
                  strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink:0, marginTop:1 }}>
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span style={{ fontSize:12, color:NAV, lineHeight:1.4 }}>{s}</span>
              </div>
            ))}
          </div>
          {excluded.length > 0 && (
            <>
              {sectionTitle('Dahil Değil')}
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {excluded.slice(0,3).map((s, i) => (
                  <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:7 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={MUT}
                      strokeWidth="2" strokeLinecap="round" style={{ flexShrink:0, marginTop:2 }}>
                      <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                    <span style={{ fontSize:11.5, color:MUT, lineHeight:1.4 }}>{s}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {}
      <div style={{ background:NAV, borderRadius:10, padding:'18px 22px', marginBottom:24, color:'#fff' }}>
        {sectionTitle && (
          <div style={{ fontSize:9, letterSpacing:'0.14em', textTransform:'uppercase',
            color:'rgba(255,255,255,0.45)', fontWeight:600, marginBottom:14 }}>
            Fiyatlandırma
          </div>
        )}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:0 }}>
          {[
            { label:'Kişi Başı',  val: unitPrice > 0 ? fmt(unitPrice) : '—' },
            { label:'Kişi Sayısı',val: `${pax} kişi` },
            { label:'İndirim',    val: discountPct > 0 ? `%${discountPct}` : '—' },
          ].map(({ label, val }) => (
            <div key={label} style={{ borderRight:'1px solid rgba(255,255,255,0.1)', padding:'0 16px 0 0', marginRight:16 }}>
              <div style={{ fontSize:10, color:'rgba(255,255,255,0.5)', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:4 }}>{label}</div>
              <div style={{ fontSize:14, fontWeight:500, color:'rgba(255,255,255,0.85)' }}>{val}</div>
            </div>
          ))}
        </div>

        <div style={{ borderTop:'1px solid rgba(255,255,255,0.12)', marginTop:14, paddingTop:14,
          display:'flex', justifyContent:'space-between', alignItems:'flex-end' }}>
          <div>
            <div style={{ display:'flex', gap:24 }}>
              <div>
                <div style={{ fontSize:9.5, color:'rgba(255,255,255,0.45)', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:3 }}>Kapora</div>
                <div style={{ fontSize:15, fontWeight:600, color:GOLD }}>{fmt(deposit)}</div>
              </div>
              <div>
                <div style={{ fontSize:9.5, color:'rgba(255,255,255,0.45)', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:3 }}>Kalan Bakiye</div>
                <div style={{ fontSize:15, fontWeight:600, color:'rgba(255,255,255,0.85)' }}>{fmt(remaining)}</div>
              </div>
            </div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:9.5, color:'rgba(255,255,255,0.45)', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:3 }}>Toplam</div>
            <div style={{ fontSize:26, fontWeight:700, fontFamily:"'Playfair Display',serif", color:'#FFFFFF' }}>
              {fmt(total)}
            </div>
          </div>
        </div>
      </div>

      {}
      {notes && (
        <div style={{ marginBottom:20, padding:'12px 16px',
          background:IVO, borderRadius:8, border:`1px solid ${LINE}` }}>
          {sectionTitle('Özel Notlar')}
          <div style={{ fontSize:12.5, color:NAV, lineHeight:1.7 }}>{notes}</div>
        </div>
      )}

      {}
      <div style={{ borderTop:`1px solid ${LINE}`, paddingTop:16,
        display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <div style={{ fontSize:11, fontWeight:600, color:NAV, marginBottom:2 }}>Dese Tour Operations</div>
          <div style={{ fontSize:10.5, color:MUT }}>hello@desetour.com · +90 555 123 45 67</div>
          <div style={{ fontSize:10.5, color:MUT }}>www.desetour.com · Istanbul, Türkiye</div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontSize:9, color:MUT, letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:3 }}>Bu teklif için iletişim</div>
          <div style={{ fontSize:11, color:GOLD, fontWeight:600 }}>berk@desetour.com</div>
        </div>
      </div>

      {}
      <div style={{ height:2, background:`linear-gradient(90deg,${GOLD},${NAV})`,
        margin: compact ? '20px -36px -28px' : '24px -48px -36px' }}/>
    </div>
  );
}

function ProposalPreviewModal({ data, quoteNumber, onClose, onSend }) {
  const [sending,     setSending]     = useState(false);
  const [sent,        setSent]        = useState(false);
  const [sendingStep, setSendingStep] = useState(null);

  async function handlePrint() {
    await autoLog('quote', data.quoteNumber, 'pdf_generated', `PDF indirildi: ${quoteNumber}`);
    window.print();
  }

  const [pdfError, setPdfError] = useState(null);

  async function handleSend() {
    const recipientEmail = data.guest?.email || '';
    if (!recipientEmail) {
      showToast("Müşteri e-posta adresi bulunamadı. Lütfen müşteri profilini güncelleyin.");
      return;
    }

    setSending(true);
    setPdfError(null);

    try {
      const cust = getCustomerById(data.guest?.customerId || null);

      let pdfAttachment = null;
      try {
        setSendingStep("PDF oluşturuluyor…");
        const pdfResult  = await PDFService.generateFromData(data, quoteNumber);
        pdfAttachment    = PDFService.buildAttachment(pdfResult);
      } catch (pdfErr) {
        setPdfError("PDF oluşturulurken bir hata oluştu. Ek olmadan gönderiliyor.");
        console.warn('[handleSend] PDF generation failed:', pdfErr.message);
      }

      setSendingStep("Email gönderiliyor…");
      const result = await EmailService.sendProposal({
        quote:         data,
        customer:      cust,
        recipientEmail,
        attachment:    pdfAttachment,
      });

      if (!result.success) {
        throw new Error(result.error || 'Gönderim başarısız.');
      }

      const logMsg = pdfAttachment
        ? `Teklif PDF ekiyle email olarak gönderildi`
        : `Teklif email olarak gönderildi`;

      await autoLog('quote', quoteNumber, 'emailed', logMsg);

      DB.activityLogs && DB.activityLogs.push({
        id:          `ACT-${Date.now()}`,
        entityType:  'quote',
        entityId:    quoteNumber,
        action:      'email_sent',
        description: logMsg,
        metadata: {
          type:           'Email',
          status:         'Sent',
          provider:       result.provider,
          messageId:      result.messageId,
          relatedQuoteId: quoteNumber,
          hasAttachment:  !!pdfAttachment,
          has_attachment: !!pdfAttachment,  // spec alias
          attachmentFile: pdfAttachment?.filename || null,
        },
        createdAt: new Date().toISOString(),
      });

      setSent(true);
      const pdfLabel = pdfAttachment
        ? `PDF eki: ${pdfAttachment.filename}`
        : 'PDF eki yok';
      const providerLabel = result.provider === 'resend'
        ? 'Resend üzerinden gönderildi'
        : 'Simüle edildi (mock mod)';
      showToast(
        pdfAttachment
          ? "Teklif PDF ekiyle email olarak gönderildi."
          : "Teklif email olarak gönderildi."
      );
      onSend && onSend();

    } catch (err) {
      showToast("Email gönderilirken bir hata oluştu.");
      console.error('[handleSend]', err.message);
    } finally {
      setSending(false);
      setSendingStep(null);
    }
  }

  return (
    <div style={{
      position:'fixed', inset:0, zIndex:2000,
      background:'rgba(13,27,62,0.75)', backdropFilter:'blur(4px)',
      display:'flex', flexDirection:'column',
      alignItems:'center', overflow:'auto',
      padding:'20px 16px 40px',
    }}>
      {}
      <div style={{
        width:'100%', maxWidth:740,
        display:'flex', alignItems:'center', justifyContent:'space-between',
        marginBottom:16, gap:12, flexWrap:'wrap',
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <button onClick={onClose} style={{
            display:'flex', alignItems:'center', gap:6,
            padding:'8px 14px', borderRadius:8, border:'1px solid rgba(255,255,255,0.2)',
            background:'transparent', color:'rgba(255,255,255,0.85)',
            cursor:'pointer', fontSize:13, fontFamily:"'DM Sans',sans-serif",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
            Geri
          </button>
          <span style={{ color:'rgba(255,255,255,0.5)', fontSize:13, fontFamily:"'DM Sans',sans-serif" }}>
            Teklif Önizlemesi — {quoteNumber}
          </span>
        </div>

        <div style={{ display:'flex', gap:8 }}>
          {pdfError && !sent && (
            <div style={{ padding:'6px 12px', borderRadius:7, background:'rgba(201,168,76,0.1)',
              border:'1px solid rgba(201,168,76,0.3)',
              fontSize:12, fontFamily:"'DM Sans',sans-serif", color:'#92660A' }}>
              ⚠ {pdfError}
            </div>
          )}
          {sent ? (
            <div style={{ padding:'8px 16px', borderRadius:8, background:'rgba(46,125,82,0.25)',
              border:'1px solid rgba(46,125,82,0.4)', color:'#86efac',
              fontSize:13, fontFamily:"'DM Sans',sans-serif" }}>
              ✓ Gönderildi
            </div>
          ) : (
            <button onClick={handleSend} disabled={sending} style={{
              display:'flex', alignItems:'center', gap:6,
              padding:'8px 18px', borderRadius:8, border:'none',
              background: sending ? 'rgba(201,168,76,0.4)' : C.gold,
              color: '#1B2D4F', cursor: sending ? 'not-allowed' : 'pointer',
              fontSize:13, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
            }}>
              {sending ? (
                <div style={{ width:14, height:14, borderRadius:'50%',
                  border:'2px solid rgba(27,45,79,0.3)', borderTopColor:'#1B2D4F',
                  animation:'spin .7s linear infinite' }}/>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              )}
              {sending ? (sendingStep || 'Hazırlanıyor…') : 'Teklifi Gönder'}
            </button>
          )}

          <button onClick={handlePrint} style={{
            display:'flex', alignItems:'center', gap:6,
            padding:'8px 18px', borderRadius:8, border:'1px solid rgba(255,255,255,0.25)',
            background:'rgba(255,255,255,0.08)', color:'rgba(255,255,255,0.9)',
            cursor:'pointer', fontSize:13, fontFamily:"'DM Sans',sans-serif",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
            PDF İndir
          </button>
        </div>
      </div>

      {}
      <div id="pdf-print-area" style={{
        width:'100%', maxWidth:740,
        boxShadow:'0 24px 80px rgba(0,0,0,0.5)',
        borderRadius:12, overflow:'hidden',
      }}>
        <ProposalTemplate data={data} />
      </div>

      {}
      <style>{`
        @media print {
          body > *:not(#pdf-print-area) { display: none !important; }
          #pdf-print-area {
            position: fixed !important; inset: 0 !important;
            width: 210mm !important; margin: 0 !important;
            box-shadow: none !important; border-radius: 0 !important;
            overflow: visible !important;
          }
          #pdf-print-area > div { width: 100% !important; max-width: none !important; }
          @page { margin: 0; size: A4 portrait; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

const PDFService = {
  _html2canvasLoaded: false,
  _jsPDFLoaded:       false,

  async _loadScript(src, globalKey) {
    if (window[globalKey]) return;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload  = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  },

  async _ensureLibs() {
    await Promise.all([
      this._loadScript(
        'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
        'html2canvas'
      ),
      this._loadScript(
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
        'jspdf'
      ),
    ]);
  },

  async _renderToPdf(element, filename) {
    await this._ensureLibs();

    if (!window.html2canvas) throw new Error('html2canvas yüklenemedi.');
    if (!window.jspdf?.jsPDF) throw new Error('jsPDF yüklenemedi.');

    const { jsPDF } = window.jspdf;

    const canvas = await window.html2canvas(element, {
      scale:           2,           // 2× for sharp print quality
      useCORS:         true,
      allowTaint:      false,
      backgroundColor: '#FFFFFF',
      width:           element.offsetWidth  || 700,
      height:          element.scrollHeight || 990,
      logging:         false,
    });

    const imgData   = canvas.toDataURL('image/jpeg', 0.92);
    const imgWidth  = canvas.width;
    const imgHeight = canvas.height;

    const pdfW    = 210;
    const pdfH    = Math.round((imgHeight / imgWidth) * pdfW);
    const pageH   = 297; // A4 height in mm

    const pdf = new jsPDF({
      orientation: pdfH > pageH ? 'portrait' : 'portrait',
      unit:        'mm',
      format:      'a4',
    });

    if (pdfH <= pageH) {
      pdf.addImage(imgData, 'JPEG', 0, 0, pdfW, pdfH, '', 'FAST');
    } else {
      let yOffset = 0;
      const pageImgH = (pageH / pdfW) * imgWidth; // pixels per page

      while (yOffset < imgHeight) {
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width  = imgWidth;
        sliceCanvas.height = Math.min(pageImgH, imgHeight - yOffset);
        const ctx = sliceCanvas.getContext('2d');
        ctx.drawImage(canvas, 0, -yOffset);
        const sliceData = sliceCanvas.toDataURL('image/jpeg', 0.92);
        const sliceH    = Math.round((sliceCanvas.height / imgWidth) * pdfW);

        if (yOffset > 0) pdf.addPage();
        pdf.addImage(sliceData, 'JPEG', 0, 0, pdfW, sliceH, '', 'FAST');
        yOffset += pageImgH;
      }
    }

    pdf.setProperties({
      title:    filename.replace('.pdf', ''),
      subject:  'Dese Tour Private Experience Proposal',
      author:   'Dese Tour',
      creator:  'Dese Tour Operations Center',
    });

    return {
      blob:     pdf.output('blob'),
      base64:   pdf.output('datauristring').split(',')[1], // pure base64
      dataUri:  pdf.output('datauristring'),
      filename,
    };
  },

  async generateFromElement(elementId, filename) {
    const el = document.getElementById(elementId);
    if (!el) {
      throw new Error(`PDF element #${elementId} bulunamadı. Önizleme açık olmalıdır.`);
    }
    return this._renderToPdf(el, filename);
  },

  async generateFromData(proposalData, quoteNumber) {
    const filename = `DES-QUOTE-${quoteNumber}.pdf`;

    const visibleEl = document.getElementById('proposal-template');
    if (visibleEl) {
      return this._renderToPdf(visibleEl, filename);
    }

    const proposalHtml = this._buildProposalHtml(proposalData);
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:720px;height:1100px;' +
      'border:none;visibility:hidden;z-index:-999;';
    document.body.appendChild(iframe);

    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      doc.open();
      doc.write(proposalHtml);
      doc.close();

      await new Promise(resolve => {
        const check = () => doc.readyState === 'complete' ? resolve() : setTimeout(check, 50);
        setTimeout(check, 100);
      });
      await new Promise(resolve => setTimeout(resolve, 300)); // font render buffer

      const el = doc.getElementById('proposal-template') || doc.body;
      return await this._renderToPdf(el, filename);
    } finally {
      document.body.removeChild(iframe);
    }
  },

  _buildProposalHtml(proposalData) {
    const { guest, tour, included, excluded, pricing, notes, validUntil, quoteNumber, date } = proposalData;
    const { fmt, total, deposit, remaining, unitPrice, pax, discountPct } = pricing;
    const NAV = '#1B2D4F', GOLD = '#C9A84C', IVO = '#FAF7F2', MUT = '#8A7F72', LINE = '#E8E2D9', GRN = '#2E7D52';

    const incItems = included.slice(0,6).map(s =>
      `<div style="display:flex;align-items:flex-start;gap:7px;margin-bottom:5px">
        <div style="color:${GRN};font-size:12px;flex-shrink:0;margin-top:1px">✓</div>
        <span style="font-size:12px;color:${NAV}">${s}</span>
       </div>`).join('');
    const excItems = excluded.slice(0,4).map(s =>
      `<div style="display:flex;align-items:flex-start;gap:7px;margin-bottom:4px">
        <div style="color:${MUT};font-size:11px;flex-shrink:0;margin-top:2px">✕</div>
        <span style="font-size:11.5px;color:${MUT}">${s}</span>
       </div>`).join('');

    return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"/>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',Helvetica,sans-serif;background:#fff;color:${NAV};-webkit-print-color-adjust:exact;print-color-adjust:exact}
</style>
</head><body>
<div id="proposal-template" style="width:700px;background:#fff;padding:36px 48px">
  <div style="height:4px;background:linear-gradient(90deg,${NAV},${GOLD});margin:-36px -48px 28px"></div>

  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,${NAV},#2C3E6B);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <div style="color:${GOLD};font-size:18px;font-weight:700">D</div>
      </div>
      <div>
        <div style="font-family:'Playfair Display',Georgia,serif;font-size:18px;font-weight:700;color:${NAV}">Dese Tour</div>
        <div style="font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:${MUT}">Private Experience Specialists</div>
      </div>
    </div>
    <div style="text-align:right">
      <div style="font-family:'Playfair Display',serif;font-size:20px;font-weight:700;color:${NAV}">Özel Seyahat Teklifi</div>
      <div style="font-size:11.5px;color:${MUT};margin-top:3px">Teklif No: <strong>${quoteNumber}</strong></div>
      <div style="font-size:11px;color:${MUT}">Tarih: ${date}</div>
      ${validUntil ? `<div style="font-size:10.5px;color:${GOLD};margin-top:3px">Geçerlilik: ${validUntil}</div>` : ''}
    </div>
  </div>

  <!-- Guest greeting -->
  <div style="background:${IVO};border-radius:10px;padding:16px 20px;margin-bottom:20px;border-left:3px solid ${GOLD}">
    <div style="font-size:11px;color:${MUT};text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Sayın Misafirimiz</div>
    <div style="font-family:'Playfair Display',serif;font-size:17px;font-weight:600;color:${NAV};margin-bottom:5px">
      ${guest.name}${guest.country ? `<span style="font-size:13px;font-weight:400;color:${MUT};margin-left:10px">${guest.flag} ${guest.country}</span>` : ''}
    </div>
    <div style="font-size:12px;color:${MUT};line-height:1.6">İstanbul'un eşsiz güzelliklerinde sizi ağırlamaktan büyük mutluluk duyacağız.</div>
  </div>

  <!-- Two columns -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
    <!-- Experience -->
    <div style="border:1px solid ${LINE};border-radius:10px;padding:14px 16px">
      <div style="font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:${MUT};font-weight:600;margin-bottom:10px">Deneyim</div>
      <div style="font-family:'Playfair Display',serif;font-size:15px;font-weight:600;color:${NAV};margin-bottom:10px;line-height:1.3">${tour.name}</div>
      ${[['Tarih',tour.date],['Süre',tour.duration],['Misafir',`${guest.pax} Kişi`],['Karşılama',tour.pickup]]
        .map(([l,v])=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid ${LINE};font-size:13px">
          <span style="color:${MUT};font-size:11px;text-transform:uppercase;letter-spacing:0.08em">${l}</span>
          <span style="color:${NAV};font-weight:500">${v||'—'}</span></div>`).join('')}
    </div>
    <!-- Services -->
    <div style="border:1px solid ${LINE};border-radius:10px;padding:14px 16px">
      <div style="font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:${MUT};font-weight:600;margin-bottom:10px">Dahil Hizmetler</div>
      ${incItems}
      ${excItems ? `<div style="font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:${MUT};font-weight:600;margin:10px 0 8px">Dahil Değil</div>${excItems}` : ''}
    </div>
  </div>

  <!-- Pricing -->
  <div style="background:${NAV};border-radius:10px;padding:18px 22px;margin-bottom:20px;color:#fff">
    <div style="font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.45);font-weight:600;margin-bottom:12px">Fiyatlandırma</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;margin-bottom:14px">
      ${[['Kişi Başı',unitPrice>0?fmt(unitPrice):'—'],['Kişi Sayısı',`${pax} kişi`],['İndirim',discountPct>0?`%${discountPct}`:'—']]
        .map(([l,v])=>`<div style="padding:0 16px 0 0;margin-right:16px;border-right:1px solid rgba(255,255,255,0.1)">
          <div style="font-size:10px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px">${l}</div>
          <div style="font-size:14px;font-weight:500;color:rgba(255,255,255,0.85)">${v}</div></div>`).join('')}
    </div>
    <div style="border-top:1px solid rgba(255,255,255,0.12);padding-top:14px;display:flex;justify-content:space-between;align-items:flex-end">
      <div style="display:flex;gap:24px">
        <div><div style="font-size:9.5px;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px">Kapora</div>
          <div style="font-size:15px;font-weight:600;color:${GOLD}">${fmt(deposit)}</div></div>
        <div><div style="font-size:9.5px;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px">Kalan</div>
          <div style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.85)">${fmt(remaining)}</div></div>
      </div>
      <div style="text-align:right">
        <div style="font-size:9.5px;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px">Toplam</div>
        <div style="font-family:'Playfair Display',serif;font-size:26px;font-weight:700;color:#fff">${fmt(total)}</div>
      </div>
    </div>
  </div>

  ${notes ? `<div style="background:${IVO};border-radius:8px;padding:12px 16px;border:1px solid ${LINE};margin-bottom:16px">
    <div style="font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:${MUT};font-weight:600;margin-bottom:8px">Özel Notlar</div>
    <div style="font-size:12.5px;color:${NAV};line-height:1.7">${notes}</div></div>` : ''}

  <!-- Footer -->
  <div style="border-top:1px solid ${LINE};padding-top:14px;display:flex;justify-content:space-between;align-items:center">
    <div>
      <div style="font-size:11px;font-weight:600;color:${NAV};margin-bottom:2px">Dese Tour Operations</div>
      <div style="font-size:10.5px;color:${MUT}">hello@desetour.com · +90 555 123 45 67</div>
      <div style="font-size:10.5px;color:${MUT}">www.desetour.com · Istanbul, Türkiye</div>
    </div>
  </div>
  <div style="height:2px;background:linear-gradient(90deg,${GOLD},${NAV});margin:16px -48px -36px"></div>
</div>
</body></html>`;
  },

  buildAttachment(pdfResult) {
    return {
      filename:    pdfResult.filename,
      content:     pdfResult.base64,
      contentType: 'application/pdf',
    };
  },
};

function ResetPasswordPage() {
  const [password,  setPassword]  = useState('');
  const [password2, setPassword2] = useState('');
  const [loading,   setLoading]   = useState(false);
  const [done,      setDone]      = useState(false);
  const [error,     setError]     = useState('');
  const [showPass,  setShowPass]  = useState(false);

  async function handleSubmit() {
    if (!password || password.length < 8) {
      setError('Şifre en az 8 karakter olmalıdır.'); return;
    }
    if (password !== password2) {
      setError('Şifreler eşleşmiyor.'); return;
    }
    setLoading(true);
    setError('');
    const sb = getSB();
    if (sb) {
      const { error: err } = await sb.auth.updateUser({ password });
      if (err) { setError('Şifre güncellenemedi: ' + err.message); setLoading(false); return; }
    } else {
      await new Promise(r => setTimeout(r, 800));
    }
    setLoading(false);
    setDone(true);
  }

  const inputStyle = {
    width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:8,
    border:`1.5px solid ${C.border}`, fontSize:14, color:C.text,
    fontFamily:"'DM Sans',sans-serif", outline:'none', background:C.white,
  };

  if (done) return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:`linear-gradient(135deg,${C.navyDeep} 0%,${C.navy} 100%)`, padding:20,
    }}>
      <div style={{
        background:C.white, borderRadius:16, padding:'44px 40px',
        width:'100%', maxWidth:400, boxShadow:'0 24px 80px rgba(13,27,62,0.45)',
        textAlign:'center',
      }}>
        <div style={{fontSize:40, marginBottom:16}}>✓</div>
        <div style={{fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:8}}>
          Şifre Güncellendi
        </div>
        <div style={{fontSize:13.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginBottom:24}}>
          {AppConfig.useSupabase ? 'Yeni şifrenizle giriş yapabilirsiniz.' : 'Demo mod: şifre değiştirildi (simüle edildi).'}
        </div>
        <button onClick={()=>{ if(NAV_REF.fn) NAV_REF.fn('/login'); }}
          style={{
            padding:'11px 28px', borderRadius:9, border:'none', cursor:'pointer',
            background:`linear-gradient(135deg,${C.navyDeep},${C.navy})`,
            color:C.white, fontSize:14, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
          }}>
          Giriş Yap
        </button>
      </div>
    </div>
  );

  return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:`linear-gradient(135deg,${C.navyDeep} 0%,${C.navy} 100%)`, padding:20,
    }}>
      <div style={{
        background:C.white, borderRadius:16, padding:'44px 40px',
        width:'100%', maxWidth:400, boxShadow:'0 24px 80px rgba(13,27,62,0.45)',
      }}>
        <div style={{textAlign:'center', marginBottom:28}}>
          <div style={{fontSize:22, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", marginBottom:6}}>
            Şifre Sıfırla
          </div>
          <div style={{fontSize:13, color:C.textFaint, fontFamily:"'DM Sans',sans-serif"}}>
            Yeni şifrenizi belirleyin
          </div>
        </div>

        {error && (
          <div style={{
            padding:'11px 14px', borderRadius:8, marginBottom:16,
            background:'#FDF2F2', border:'1px solid #FECACA',
            fontSize:13, color:'#DC2626', fontFamily:"'DM Sans',sans-serif",
          }}>{error}</div>
        )}

        {!AppConfig.useSupabase && (
          <div style={{
            padding:'10px 14px', borderRadius:8, marginBottom:16,
            background:'rgba(201,168,76,0.08)', border:'1px solid rgba(201,168,76,0.25)',
            fontSize:12, color:C.amber, fontFamily:"'DM Sans',sans-serif",
          }}>
            Demo modu — şifre gerçekte değiştirilmez.
          </div>
        )}

        <div style={{display:'flex', flexDirection:'column', gap:14}}>
          <div>
            <label style={{display:'block', fontSize:12.5, fontWeight:500, color:C.textMid, marginBottom:5, fontFamily:"'DM Sans',sans-serif"}}>
              Yeni Şifre
            </label>
            <div style={{position:'relative'}}>
              <input type={showPass?'text':'password'} value={password}
                onChange={e=>setPassword(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&handleSubmit()}
                placeholder="En az 8 karakter"
                style={inputStyle}
                onFocus={e=>e.target.style.borderColor=C.navy}
                onBlur={e=>e.target.style.borderColor=C.border}
              />
              <button onClick={()=>setShowPass(v=>!v)} style={{
                position:'absolute', right:12, top:'50%', transform:'translateY(-50%)',
                background:'none', border:'none', cursor:'pointer', color:C.textFaint,
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  {showPass ? <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></> : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>}
                </svg>
              </button>
            </div>
          </div>

          <div>
            <label style={{display:'block', fontSize:12.5, fontWeight:500, color:C.textMid, marginBottom:5, fontFamily:"'DM Sans',sans-serif"}}>
              Şifre Tekrar
            </label>
            <input type="password" value={password2}
              onChange={e=>setPassword2(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&handleSubmit()}
              placeholder="Şifreyi tekrar girin"
              style={{...inputStyle, borderColor: password2 && password !== password2 ? C.red : C.border}}
              onFocus={e=>e.target.style.borderColor=C.navy}
              onBlur={e=>e.target.style.borderColor=C.border}
            />
          </div>

          <button onClick={handleSubmit} disabled={loading} style={{
            width:'100%', padding:'13px', borderRadius:9, border:'none',
            background:loading ? C.textFaint : `linear-gradient(135deg,${C.navyDeep},${C.navy})`,
            color:C.white, fontSize:14.5, fontWeight:600,
            fontFamily:"'DM Sans',sans-serif", cursor:loading?'not-allowed':'pointer',
            display:'flex', alignItems:'center', justifyContent:'center', gap:8,
          }}>
            {loading && <div style={{width:16,height:16,borderRadius:'50%',border:'2px solid rgba(255,255,255,0.4)',borderTopColor:'#fff',animation:'spin .7s linear infinite'}}/>}
            {loading ? 'Güncelleniyor…' : 'Şifreyi Güncelle'}
          </button>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );
}

function App() {
  const { base, param, navigate, path } = useHashRouter();
  const { isMobile, isTablet } = useBreakpoint();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  // NAV_REF.fn and ROUTER_STATE.setPath are managed by useHashRouter's effect
  // Only TOAST_REF needs App-level assignment
  TOAST_REF.show = setToastMsg;

  if (base === "login") {
    return <LoginPage onLogin={()=>navigate('/dashboard')}/>;
  }

  if (base === "reset-password") {
    return <ResetPasswordPage/>;
  }

  function renderPage() {
    const auth = getAuthContext();
    const role = auth.role;

    if (!canAccess(role, base)) {
      return <AccessDenied page={base}/>;
    }

    if (base === "more") return <MobileMorePage navigate={navigate}/>;

    // ── Mobile: dedicated screens for every route reachable from daily
    // operations, list AND detail. Each one is its own information
    // architecture — not the desktop page reused at a narrow width.
    if (isMobile) {
      if (base === "dashboard") return <MobileHomePage navigate={navigate}/>;
      if (base === "calendar") return <MobileCalendarPage navigate={navigate}/>;
      if (base === "messages") return <MobileMessagesPage/>;

      if (base === "leads" && param) return <MobileLeadDetailPage leadId={param} onBack={()=>navigate('/leads')}/>;
      if (base === "leads") return <MobileRequestsPage onSelectLead={id=>navigate('/leads/'+id)}/>;

      if (base === "reservations" && param) return <MobileReservationDetailPage resId={param} onBack={()=>navigate('/reservations')}/>;
      if (base === "reservations") return <MobileReservationsPage onSelect={id=>navigate('/reservations/'+id)}/>;

      if (base === "customers" && param) return <MobileGuestDetailPage guestId={param} onBack={()=>navigate('/customers')}/>;
      if (base === "customers") return <MobileGuestsPage onSelectGuest={id=>navigate('/customers/'+id)}/>;

      if (base === "quotes" && param === "new") return <MobileNewQuotePage onBack={()=>navigate('/quotes')}/>;
      if (base === "quotes" && param) return <MobileQuoteDetailPage quoteId={param} onBack={()=>navigate('/quotes')}/>;
      if (base === "quotes") return <MobileQuotesPage onSelectQuote={id=>navigate('/quotes/'+id)} onNewQuote={()=>navigate('/quotes/new')}/>;

      if (base === "payments") return <MobilePaymentsPage/>;
      if (base === "tasks" || base === "reminders") return <MobileTasksQueuePage/>;
    }

    if (base === "dashboard") return <Dashboard/>;

    if (base === "leads" && param)
      return <LeadDetailPage onBack={()=>navigate('/leads')} leadId={param}/>;
    if (base === "leads")
      return <LeadsPage onSelectLead={id=>navigate('/leads/'+id)}/>;

    if (base === "quotes" && param === "new")
      return <NewProposalPage onBack={()=>navigate('/quotes')}/>;
    if (base === "quotes" && param)
      return <QuoteDetailPage quoteId={param} onBack={()=>navigate('/quotes')}/>;
    if (base === "quotes")
      return <QuotesPage
        onSelectQuote={id=>navigate('/quotes/'+id)}
        onNewQuote={()=>navigate('/quotes/new')}
      />;

    if (base === "reservations" && param)
      return <ReservationDetailPage resId={param} onBack={()=>navigate('/reservations')}/>;
    if (base === "reservations")
      return <ReservationsPage onSelect={id=>navigate('/reservations/'+id)}/>;

    if (base === "customers" && param)
      return <GuestDetailPage guestId={param} onBack={()=>navigate('/customers')}/>;
    if (base === "customers")
      return <CustomersPage onSelectGuest={id=>navigate('/customers/'+id)}/>;

    if (base === "tours" && param)
      return <TourDetailPage tourId={param} onBack={()=>navigate('/tours')}/>;
    if (base === "tours")
      return <ToursPage onSelect={id=>navigate('/tours/'+id)}/>;

    if (base === "calendar")  return <CalendarPage/>;
    if (base === "tasks")     return <TasksPage/>;
    if (base === "payments")  return <PaymentsPage/>;
    if (base === "reminders") return <RemindersPage/>;
    if (base === "reports")   return <ReportsPage/>;
    if (base === "settings")  return <SettingsPage/>;
    if (base === "messages")  return <MessagesPage/>;

    return <NotFound404/>;
  }

  return (
    <AuthGuard>
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { height: 100%; }
        body { background: #EDE9DF; font-family: 'DM Sans', sans-serif; -webkit-font-smoothing: antialiased; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #D4CEC4; border-radius: 99px; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(7px); } to { opacity:1; transform:translateY(0); } }
        @keyframes slideIn { from { transform:translateX(-100%); } to { transform:translateX(0); } }
        .fade { animation: fadeUp 0.25s ease both; }
        a { cursor: pointer; }
        @media (max-width: 767px) {
          .rsp-table { display: none !important; }
          .rsp-cards { display: flex !important; }
          .rsp-hide  { display: none !important; }
          .rsp-stack { flex-direction: column !important; }
          .rsp-full  { width: 100% !important; max-width: 100% !important; }
          .rsp-p-sm  { padding: 14px !important; }
          .rsp-gap-sm{ gap: 12px !important; }
          .modal-inner { max-height: 95vh !important; border-radius: 16px 16px 0 0 !important; align-self: flex-end !important; }

          /* Page-header search+button rows: stack full-width instead of
             fighting for space at a fixed pixel width each. */
          .page-header-actions {
            flex-direction: column !important;
            align-items: stretch !important;
            width: 100% !important;
          }
          .page-header-actions > * { width: 100% !important; }
          .page-header-actions input { width: 100% !important; box-sizing: border-box !important; }

          /* ── Shared mobile layout primitives ──────────────────────────
             Apply these classNames alongside existing inline styles —
             !important lets a single rule override desktop inline widths
             everywhere at once, instead of hand-editing each page. */

          /* Any "N stat/KPI cards in a row" grid → clean 2-column grid. */
          .rsp-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 10px !important; }
          .rsp-stat-grid-1 { grid-template-columns: 1fr !important; }

          /* Any "content 1fr + fixed-px side panel" split layout →
             single column, panel stacks below content. */
          .rsp-split { grid-template-columns: 1fr !important; }

          /* Deliberate horizontal-scroll container (tab bars, chip rows) —
             distinct from accidental page overflow: contained, momentum-
             scrolled, and never expands the page itself. */
          .rsp-scroll-x {
            overflow-x: auto !important;
            overflow-y: hidden !important;
            -webkit-overflow-scrolling: touch;
            overscroll-behavior-x: contain;
            scrollbar-width: none;
            flex-wrap: nowrap !important;
          }
          .rsp-scroll-x::-webkit-scrollbar { display: none; }

          /* Comfortable touch targets for every interactive control. */
          button, a, input, select, textarea { min-height: 44px; }
          input, select, textarea { font-size: 16px; } /* prevents iOS auto-zoom on focus */
        }
        @media (min-width: 768px) {
          .rsp-table { display: table !important; }
          .rsp-cards { display: none !important; }
        }
        * { -webkit-tap-highlight-color: transparent; }
        button, a { min-height: 36px; }
      `}</style>

      {!isMobile && (
        <Sidebar
          currentBase={base}
          collapsed={sidebarCollapsed}
          onToggle={()=>setSidebarCollapsed(c=>!c)}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={()=>setMobileSidebarOpen(false)}
        />
      )}

      {isMobile && (
        <div style={{
          position:"fixed", top:0, left:0, right:0, zIndex:200,
          background:`linear-gradient(135deg,${C.navyDeep} 0%,${C.navy} 100%)`,
          padding:"env(safe-area-inset-top, 0px) 16px 0",
          height:"calc(48px + env(safe-area-inset-top, 0px))",
          display:"flex", alignItems:"center", justifyContent:"space-between",
          boxShadow:"0 2px 12px rgba(13,27,62,0.3)",
        }}>
          <div style={{fontSize:15,fontWeight:600,color:C.ivory,fontFamily:"'Playfair Display',serif"}}>
            {MOBILE_PAGE_TITLES[base] || "Dese Tour"}
          </div>
          <img src="/seffafdeselogo.png" alt="Dese Tour" style={{height:20, width:"auto", opacity:0.9}}/>
        </div>
      )}

      {isMobile && <BottomNav active={base} navigate={navigate}/>}

      <main style={{
        marginLeft: isMobile ? 0 : (sidebarCollapsed ? 64 : 208),
        marginTop: isMobile ? "calc(48px + env(safe-area-inset-top, 0px))" : 0,
        minHeight: isMobile ? "100dvh" : "100vh",
        padding: isMobile ? "14px 12px calc(68px + env(safe-area-inset-bottom, 0px))" : isTablet ? "20px 18px 40px" : "26px 28px 52px",
        background: isMobile ? C.ivory : "#EDE9DF",
        transition:"margin-left 0.22s cubic-bezier(0.4,0,0.2,1)",
        overflowX:"hidden",
        maxWidth:"100vw",
        boxSizing:"border-box",
      }}>
        <div className="fade" key={path}>
          {renderPage()}
        </div>
      </main>
      {toastMsg && <Toast msg={toastMsg} onDone={()=>setToastMsg(null)}/>}
      <DataSourceBadge/>
    </>
    </AuthGuard>
  );
}

/* ── Error Boundary ─────────────────────────────────────────────────── */

/* ── UUID validation ─────────────────────────────────────────────────── */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) { return typeof v === 'string' && UUID_RE.test(v); }
function isMockId(v) { return typeof v === 'string' && /^[A-Z]+-\d/.test(v); }

/* Safe getById — shows clean error for mock/invalid IDs in Supabase mode */
function safeParam(param) {
  if (!param) return { id: null, invalid: false };
  if (AppConfig.useSupabase && isMockId(param)) {
    return { id: param, invalid: true, reason: 'demo' };
  }
  if (AppConfig.useSupabase && param.length > 10 && !isUUID(param)) {
    return { id: param, invalid: true, reason: 'format' };
  }
  return { id: param, invalid: false };
}


/* ── Missing component stubs — Sprint 15 Critical Stabilization ───── */

function MobileCard({ onClick, children, style }) {
  return (
    <div onClick={onClick} style={{
      padding:'12px 16px', borderBottom:`1px solid ${C.border}`,
      cursor: onClick ? 'pointer' : 'default', background:C.white,
      transition:'background 0.1s', ...style,
    }}
      onMouseEnter={e=>onClick&&(e.currentTarget.style.background=C.ivory)}
      onMouseLeave={e=>onClick&&(e.currentTarget.style.background=C.white)}
    >{children}</div>
  );
}

function MobileCardList({ items, renderCard, emptyText }) {
  if (!items || items.length === 0) return (
    <div style={{padding:'32px 16px', textAlign:'center', color:C.textFaint, fontSize:13, fontFamily:"'DM Sans',sans-serif"}}>
      {emptyText || 'Kayıt bulunamadı.'}
    </div>
  );
  return <div>{items.map((item, i) => renderCard(item, i))}</div>;
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE PRODUCT PRIMITIVES
   A dedicated visual/interaction language for the mobile surface —
   calm, card-based, touch-first. Desktop components are untouched;
   these are only ever used behind an isMobile check. All read/write
   still goes through the same useRepo/useRepoMutation/getActiveRepo
   plumbing as desktop — no business logic lives in this section.
   ══════════════════════════════════════════════════════════════════════ */

/* Compact status pill. tone: good|warn|bad|info|neutral */
function MobileStatusChip({ label, tone = "neutral" }) {
  const TONES = {
    good:    { color:C.green,  bg:C.greenBg },
    warn:    { color:C.amber,  bg:C.amberBg },
    bad:     { color:C.red,    bg:C.redBg   },
    info:    { color:C.blue,   bg:C.blueBg  },
    gold:    { color:"#8A6D1F",bg:C.goldPale },
    neutral: { color:C.textMuted, bg:C.ivoryDark },
  };
  const t = TONES[tone] || TONES.neutral;
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:4,
      padding:"3px 9px", borderRadius:99,
      background:t.bg, color:t.color,
      fontSize:11, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
      whiteSpace:"nowrap",
    }}>{label}</span>
  );
}

/* Elevated, rounded, restrained-shadow card — the primary "unit" of the
   mobile product surface. One idea per card; no borders stacked on top
   of the shadow. */
function MobileEntityCard({ children, onClick, style }) {
  return (
    <div onClick={onClick} style={{
      background:C.white, borderRadius:14,
      padding:"14px 16px",
      boxShadow:"0 1px 2px rgba(15,29,53,0.05), 0 1px 8px rgba(15,29,53,0.05)",
      cursor: onClick ? "pointer" : "default",
      WebkitTapHighlightColor:"transparent",
      ...style,
    }}>{children}</div>
  );
}

/* Calm section wrapper: a small caption-style title, optional trailing
   action, and vertically stacked content. No border/box by default —
   sections are separated by rhythm (spacing), not chrome. */
function MobileSection({ title, action, onAction, children, tight }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap: tight ? 8 : 10 }}>
      {(title || action) && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 2px" }}>
          {title && (
            <div style={{ fontSize:13, fontWeight:600, color:C.textMid, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.04em" }}>
              {title}
            </div>
          )}
          {action && (
            <button onClick={onAction} style={{
              border:"none", background:"transparent", cursor:"pointer",
              color:C.gold, fontSize:12.5, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
              padding:"4px 2px",
            }}>{action}</button>
          )}
        </div>
      )}
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>{children}</div>
    </div>
  );
}

/* Sticky bottom action bar — for a page's one primary action, always
   reachable, respecting the home-indicator safe area and (when the
   bottom tab bar is also present) sitting above it. */
function MobileActionBar({ children, aboveTabBar }) {
  return (
    <div style={{
      position:"sticky", bottom: aboveTabBar ? 58 : 0, left:0, right:0,
      background:"rgba(248,245,238,0.92)", backdropFilter:"blur(8px)",
      borderTop:`1px solid ${C.borderLight}`,
      padding:`10px 16px calc(10px + env(safe-area-inset-bottom, 0px))`,
      display:"flex", gap:10, zIndex:40,
      marginLeft:-12, marginRight:-12, marginBottom:-12,
    }}>{children}</div>
  );
}

/* Full-screen native-feeling form shell: fixed top bar (Cancel / Title /
   Save), vertically scrolling body, page behind never scrolls. Replaces
   the centered desktop modal on mobile — the fields passed as children
   (FGrid/FRow/FText/etc.) and the submit handler are the same ones the
   desktop <Modal> uses, so validation/business logic is never duplicated. */
function MobileFullScreenForm({ title, onCancel, onSubmit, submitLabel, submitting, children }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:1000, background:C.ivory,
      display:"flex", flexDirection:"column",
    }}>
      {}
      <div style={{
        flexShrink:0, background:C.white, borderBottom:`1px solid ${C.border}`,
        paddingTop:"env(safe-area-inset-top, 0px)",
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"calc(10px + env(safe-area-inset-top, 0px)) 8px 10px",
      }}>
        <button onClick={onCancel} style={{
          border:"none", background:"transparent", cursor:"pointer",
          color:C.textMid, fontSize:14.5, fontFamily:"'DM Sans',sans-serif",
          padding:"8px 10px", minWidth:44,
        }}>İptal</button>
        <div style={{ fontSize:15.5, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", textAlign:"center", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", padding:"0 6px" }}>
          {title}
        </div>
        <button onClick={onSubmit} disabled={submitting} style={{
          border:"none", background:"transparent", cursor: submitting ? "default" : "pointer",
          color: submitting ? C.textFaint : C.gold, fontSize:14.5, fontWeight:700,
          fontFamily:"'DM Sans',sans-serif", padding:"8px 10px", minWidth:44,
        }}>{submitLabel || "Kaydet"}</button>
      </div>
      {}
      <div style={{ flex:1, overflowY:"auto", padding:"18px 16px calc(32px + env(safe-area-inset-bottom, 0px))" }}>
        {children}
      </div>
    </div>
  );
}

/* Chooses the desktop centered Modal or the mobile full-screen form shell
   for the same fields/submit handler — the one place that decision is
   made, so create/edit flows don't each re-implement it. */
function FormShell({ isMobile, title, onClose, onSubmit, submitLabel, submitting, wide, danger, children }) {
  if (isMobile) {
    return (
      <MobileFullScreenForm title={title} onCancel={onClose} onSubmit={onSubmit} submitLabel={submitting?"Kaydediliyor…":submitLabel} submitting={submitting}>
        {children}
      </MobileFullScreenForm>
    );
  }
  return (
    <Modal title={title} onClose={onClose} onSubmit={onSubmit} submitLabel={submitting?"Kaydediliyor…":submitLabel} wide={wide} danger={danger}>
      {children}
    </Modal>
  );
}

/* Persistent bottom tab bar — the primary navigation surface on mobile.
   Deliberately five destinations: three high-frequency daily-operations
   routes, Calendar, and More (everything else, incl. logout). */
const MOBILE_PAGE_TITLES = {
  dashboard:"Bugün", leads:"Talepler", customers:"Misafirler", quotes:"Teklifler",
  reservations:"Rezervasyonlar", calendar:"Takvim", tours:"Turlar", tasks:"Yapılacaklar",
  payments:"Ödemeler", reminders:"Hatırlatmalar", reports:"Raporlar", settings:"Ayarlar",
  messages:"Mesajlar", more:"Diğer",
};
const BOTTOM_NAV_ITEMS = [
  { id:"dashboard",    label:"Bugün",   icon:"M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z M9 21V12h6v9" },
  { id:"leads",        label:"Talepler",icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
  { id:"reservations", label:"Rezerv.", icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
  { id:"calendar",     label:"Takvim",  icon:"M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z" },
  { id:"more",         label:"Diğer",   icon:"M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" },
];
function BottomNav({ active, navigate }) {
  return (
    <nav style={{
      position:"fixed", left:0, right:0, bottom:0, zIndex:250,
      background:"rgba(255,255,255,0.96)", backdropFilter:"blur(10px)",
      borderTop:`1px solid ${C.border}`,
      display:"flex",
      paddingBottom:"env(safe-area-inset-bottom, 0px)",
      boxShadow:"0 -2px 12px rgba(15,29,53,0.06)",
    }}>
      {BOTTOM_NAV_ITEMS.map(it=>{
        const on = active === it.id;
        return (
          <button key={it.id} onClick={()=>navigate('/'+it.id)} style={{
            flex:1, border:"none", background:"transparent", cursor:"pointer",
            display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
            gap:3, padding:"8px 4px 6px", minHeight:52,
            color: on ? C.navy : C.textFaint,
          }}>
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={on?2:1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d={it.icon}/>
            </svg>
            <span style={{ fontSize:10, fontWeight: on?600:400, fontFamily:"'DM Sans',sans-serif" }}>{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/* "More" screen: secondary modules + identity + logout. Replaces the
   hamburger drawer as the primary way to reach everything not on the
   bottom tab bar. */
function MobileMorePage({ navigate }) {
  const auth = getAuthContext();
  const ALL_ITEMS = [
    { id:"customers",  label:"Misafirler",     icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" },
    { id:"quotes",     label:"Teklifler",      icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6" },
    { id:"tours",      label:"Turlar",         icon:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10" },
    { id:"payments",   label:"Ödemeler",       icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20" },
    { id:"tasks",      label:"Yapılacaklar",   icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
    { id:"reminders",  label:"Hatırlatmalar",  icon:"M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" },
    { id:"messages",   label:"Mesajlar",       icon:"M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" },
    { id:"reports",    label:"Raporlar",       icon:"M18 20V10M12 20V4M6 20v-6" },
    { id:"settings",   label:"Ayarlar",        icon:"M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" },
  ].filter(it => canAccess(auth.role, it.id));

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:22, paddingBottom:20 }}>
      {}
      <div style={{ display:"flex", alignItems:"center", gap:12 }}>
        <div style={{
          width:48, height:48, borderRadius:"50%", flexShrink:0,
          background:C.goldPale, border:`1.5px solid ${C.gold}55`,
          display:"flex", alignItems:"center", justifyContent:"center",
        }}>
          <span style={{ fontSize:16, fontWeight:700, color:"#8A6D1F", fontFamily:"'DM Sans',sans-serif" }}>{auth.initials}</span>
        </div>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:16, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{auth.displayName}</div>
          <div style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>{auth.role}</div>
        </div>
      </div>

      {}
      <MobileEntityCard style={{ padding:0, overflow:"hidden" }}>
        {ALL_ITEMS.map((it,i)=>(
          <button key={it.id} onClick={()=>navigate('/'+it.id)} style={{
            width:"100%", display:"flex", alignItems:"center", gap:12,
            padding:"14px 16px", border:"none", background:"transparent", cursor:"pointer",
            borderBottom: i<ALL_ITEMS.length-1 ? `1px solid ${C.borderLight}` : "none",
            textAlign:"left",
          }}>
            <div style={{ width:32, height:32, borderRadius:8, flexShrink:0, background:C.ivory, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.navy} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={it.icon}/></svg>
            </div>
            <span style={{ flex:1, fontSize:14.5, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{it.label}</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.textFaint} strokeWidth="2" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        ))}
      </MobileEntityCard>

      {}
      <button onClick={()=>auth.logout()} style={{
        display:"flex", alignItems:"center", justifyContent:"center", gap:8,
        padding:"13px 16px", borderRadius:12, border:`1px solid ${C.border}`,
        background:C.white, color:C.red, cursor:"pointer",
        fontSize:14, fontWeight:500, fontFamily:"'DM Sans',sans-serif",
      }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
        Çıkış Yap
      </button>

      <div style={{ textAlign:"center", fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>
        Dese Tour Operations Center · v1.0
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE HOME — an operations command center for *today*, built from
   scratch. Not the desktop Dashboard's composition: no KPI wall, no
   dense grids. Answers three questions: what's happening today, what
   needs attention, what should I do next. Same data hooks as desktop
   (useRepo/computeUrgent/etc.) — only the presentation is different.
   ══════════════════════════════════════════════════════════════════════ */
function MobileHomePage({ navigate }) {
  const auth = getAuthContext();
  const [quickAction, setQuickAction] = useState(null); // null|'guest'|'lead'|'reservation'|'payment'

  const { data:repoLeads }  = useRepo("lead",        "getAll");
  const { data:repoRes }    = useRepo("reservation", "getAll");
  const { data:repoPays }   = useRepo("payment",     "getAll");
  const { data:repoTasks }  = useRepo("task",        "getAll");
  const { data:repoRems }   = useRepo("reminder",    "getAll");
  const { data:repoAct }    = useRepo("activity",    "getAll", { limit:5 });

  const urgentItems = useMemo(
    () => computeUrgent(repoLeads, repoRes, repoPays, repoTasks, repoRems),
    [repoLeads, repoRes, repoPays, repoTasks, repoRems]
  );

  const allRes = repoRes ?? [];
  const todaysTours = allRes
    .filter(r => r.date === _TODAY_STR || r.checkIn === _TODAY_ISO)
    .sort((a,b) => (a.time||"").localeCompare(b.time||""));
  const upcoming = allRes
    .filter(r => !["Tamamlandı","İptal"].includes(r.opStatus) && r.date !== _TODAY_STR && r.checkIn !== _TODAY_ISO)
    .slice(0, 4);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Günaydın" : hour < 18 ? "İyi günler" : "İyi akşamlar";
  const todayLabel = new Date().toLocaleDateString("tr-TR", { weekday:"long", day:"numeric", month:"long" });
  const firstName = (auth.displayName||"").split(" ")[0] || "";

  const QUICK_ACTIONS = [
    { key:"lead",        label:"Yeni Talep",        icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
    { key:"guest",       label:"Yeni Misafir",      icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" },
    { key:"reservation", label:"Yeni Rezervasyon",  icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
    { key:"payment",     label:"Ödeme Ekle",        icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20" },
  ];

  const PAY_TONE = { "Ödendi":"good", "Kapora Ödendi":"warn", "Bekliyor":"bad" };
  const ACT_ICON = {
    lead:{icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", tone:"info"},
    quote:{icon:"M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6", tone:"warn"},
    payment:{icon:"M2 9a2 2 0 012-2h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9zM2 13h20", tone:"good"},
    reservation:{icon:"M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", tone:"neutral"},
    customer:{icon:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2", tone:"neutral"},
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:22 }}>

      {}
      <div>
        <div style={{ fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>
          {greeting}{firstName ? `, ${firstName}` : ""}
        </div>
        <div style={{ fontSize:13, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:2, textTransform:"capitalize" }}>
          {todayLabel}
        </div>
      </div>

      {}
      {urgentItems.length > 0 && (
        <MobileSection title="Dikkat Gerektiren">
          {urgentItems.slice(0,3).map(item=>(
            <MobileEntityCard key={item.id} style={{ borderLeft:`3px solid ${item.level==="high"?C.red:C.amber}` }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
                <div style={{
                  width:30, height:30, borderRadius:8, flexShrink:0,
                  background: item.level==="high" ? C.redBg : C.amberBg,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  color: item.level==="high" ? C.red : C.amber,
                }}>
                  <GIc d={item.icon} size={14} sw={1.7}/>
                </div>
                <div style={{ minWidth:0, flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif", lineHeight:1.35 }}>{item.title}</div>
                  <div style={{ fontSize:11.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:3 }}>{item.sub}</div>
                </div>
              </div>
            </MobileEntityCard>
          ))}
        </MobileSection>
      )}

      {}
      <MobileSection title="Bugünkü Turlar" action={todaysTours.length>0?"Takvim":null} onAction={()=>navigate('/calendar')}>
        {todaysTours.length === 0 ? (
          <MobileEntityCard style={{ textAlign:"center", padding:"22px 16px" }}>
            <div style={{ fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Bugün için planlanmış tur yok.</div>
          </MobileEntityCard>
        ) : todaysTours.map((t,i)=>(
          <MobileEntityCard key={t.id||i} onClick={()=>navigate('/reservations/'+t.id)}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:6 }}>
              <span style={{ fontSize:14, fontWeight:700, color:C.navy, fontFamily:"'Playfair Display',serif" }}>{t.time||"—"}</span>
              <MobileStatusChip label={t.payStatus||"—"} tone={PAY_TONE[t.payStatus]||"neutral"}/>
            </div>
            <div style={{ fontSize:14, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{t.name || t.customer || "—"}</div>
            <div style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{t.tour || "—"} · {t.pax||1} kişi</div>
            <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:8 }}>
              <MobileStatusChip label={t.guide ? `Rehber: ${t.guide}` : "Rehber Atanmadı"} tone={t.guide?"good":"bad"}/>
            </div>
          </MobileEntityCard>
        ))}
      </MobileSection>

      {}
      {upcoming.length > 0 && (
        <MobileSection title="Yaklaşan Rezervasyonlar" action="Tümü" onAction={()=>navigate('/reservations')}>
          <MobileEntityCard style={{ padding:0, overflow:"hidden" }}>
            {upcoming.map((r,i)=>(
              <div key={r.id||i}
                onClick={()=>navigate('/reservations/'+r.id)}
                style={{
                  display:"flex", alignItems:"center", gap:10, padding:"12px 14px", cursor:"pointer",
                  borderBottom: i<upcoming.length-1 ? `1px solid ${C.borderLight}` : "none",
                }}>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:C.ivory, borderRadius:8, padding:"4px 8px", minWidth:44 }}>
                  <span style={{ fontSize:11, fontWeight:700, color:C.navy, fontFamily:"'DM Sans',sans-serif" }}>{(r.date||"—").split(" ")[0]}</span>
                  <span style={{ fontSize:9, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{(r.date||"—").split(" ")[1]||""}</span>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.name || r.customer || "—"}</div>
                  <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{r.tour||"—"}</div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.textFaint} strokeWidth="2" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
              </div>
            ))}
          </MobileEntityCard>
        </MobileSection>
      )}

      {}
      <MobileSection title="Hızlı İşlemler">
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          {QUICK_ACTIONS.map(a=>(
            <button key={a.key} onClick={()=>setQuickAction(a.key)} style={{
              display:"flex", flexDirection:"column", alignItems:"flex-start", gap:8,
              padding:"14px", borderRadius:14, border:"none", cursor:"pointer",
              background:C.white, textAlign:"left", minHeight:84,
              boxShadow:"0 1px 2px rgba(15,29,53,0.05), 0 1px 8px rgba(15,29,53,0.05)",
            }}>
              <div style={{ width:32, height:32, borderRadius:8, background:C.goldPale, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <GIc d={a.icon} size={15} sw={1.8} color="#8A6D1F"/>
              </div>
              <span style={{ fontSize:12.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{a.label}</span>
            </button>
          ))}
        </div>
      </MobileSection>

      {}
      {repoAct && repoAct.length > 0 && (
        <MobileSection title="Son Aktiviteler">
          <MobileEntityCard style={{ padding:0, overflow:"hidden" }}>
            {repoAct.slice(0,5).map((a,i)=>{
              const meta = ACT_ICON[a.type||a.entityType] || ACT_ICON.lead;
              return (
                <div key={i} style={{
                  display:"flex", alignItems:"flex-start", gap:10, padding:"11px 14px",
                  borderBottom: i<Math.min(repoAct.length,5)-1 ? `1px solid ${C.borderLight}` : "none",
                }}>
                  <div style={{ width:26, height:26, borderRadius:7, flexShrink:0, marginTop:1, background:C.ivory, display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <GIc d={meta.icon} size={12} sw={1.6}/>
                  </div>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div style={{ fontSize:12.5, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{a.description || a.detail || "—"}</div>
                    <div style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{a.date||""} {a.time||""}</div>
                  </div>
                </div>
              );
            })}
          </MobileEntityCard>
        </MobileSection>
      )}

      {quickAction === "guest" && <NewGuestModal onClose={()=>setQuickAction(null)}/>}
      {quickAction === "lead" && <NewLeadModal onClose={()=>setQuickAction(null)} onSuccess={()=>setQuickAction(null)}/>}
      {quickAction === "reservation" && <NewReservationModal onClose={()=>setQuickAction(null)} onSuccess={()=>setQuickAction(null)}/>}
      {quickAction === "payment" && <NewPaymentModal onClose={()=>setQuickAction(null)}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE REQUESTS — a lightweight sales inbox, not the desktop leads
   table. One card per request; the two most common next actions (call,
   quote) are one tap away, everything else opens the (already mobile-
   adapted) LeadDetailPage.
   ══════════════════════════════════════════════════════════════════════ */
function MobileRequestsPage({ onSelectLead }) {
  const [filter, setFilter] = useState("Açık");
  const { data:repoLeads, loading } = useRepo("lead", "getAll");
  const { sources } = useSources();
  const [showNew, setShowNew] = useState(false);

  const all = repoLeads ?? [];
  const FILTERS = ["Açık","Yeni","Teklif Gönderildi","Tümü"];
  const filtered = all.filter(l => {
    if (filter === "Tümü") return true;
    if (filter === "Açık") return !["Onaylandı","İptal"].includes(l.status);
    return l.status === filter;
  });

  const STATUS_TONE = {
    "Yeni":"info", "Görüşüldü":"neutral", "Teklif Hazırlanıyor":"neutral",
    "Teklif Gönderildi":"warn", "Teklif Onaylandı":"good", "Onaylandı":"good",
    "İptal":"bad", "Beklemede":"neutral",
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      {}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
        <div style={{ fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>Talepler</div>
        <button onClick={()=>setShowNew(true)} style={{
          display:"flex", alignItems:"center", gap:6, padding:"9px 14px", borderRadius:10,
          border:"none", background:C.navy, color:C.white, cursor:"pointer",
          fontSize:13, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
        }}>
          <GIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
          Yeni
        </button>
      </div>

      {}
      <div className="rsp-scroll-x" style={{ display:"flex", gap:8 }}>
        {FILTERS.map(f=>(
          <button key={f} onClick={()=>setFilter(f)} style={{
            flexShrink:0, padding:"7px 14px", borderRadius:99, cursor:"pointer",
            border: filter===f ? "none" : `1px solid ${C.border}`,
            background: filter===f ? C.navy : C.white,
            color: filter===f ? C.white : C.textMid,
            fontSize:12.5, fontWeight:500, fontFamily:"'DM Sans',sans-serif",
          }}>{f}</button>
        ))}
      </div>

      {}
      {loading ? <LoadingState label="Talepler yükleniyor…"/> : filtered.length === 0 ? (
        <MobileEntityCard style={{ textAlign:"center", padding:"36px 16px" }}>
          <div style={{ fontSize:13, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Bu filtre için talep yok.</div>
        </MobileEntityCard>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {filtered.map(l=>{
            const srcLabel = (sources||[]).find(s=>s.id===l.sourceId)?.name || l.sourceId || "—";
            return (
              <MobileEntityCard key={l.id} onClick={()=>onSelectLead(l.id)}>
                <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8, marginBottom:6 }}>
                  <div style={{ fontSize:14.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{l.name}</div>
                  <MobileStatusChip label={l.status} tone={STATUS_TONE[l.status]||"neutral"}/>
                </div>
                <div style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>{l.tour || "Deneyim belirtilmedi"}</div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:6, flexWrap:"wrap" }}>
                  {l.dateRange && <span style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>📅 {l.dateRange}</span>}
                  <span style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{srcLabel}</span>
                  <span style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>· {l.ago}</span>
                </div>
                {l.phone && (
                  <div style={{ display:"flex", gap:8, marginTop:10 }}>
                    <a href={`tel:${l.phone}`} onClick={e=>e.stopPropagation()} style={{
                      flex:1, textAlign:"center", padding:"8px 0", borderRadius:8,
                      border:`1px solid ${C.border}`, color:C.navy, fontSize:12.5, fontWeight:500,
                      fontFamily:"'DM Sans',sans-serif", textDecoration:"none",
                    }}>Ara</a>
                    <button onClick={e=>{e.stopPropagation(); NAV_REF.fn && NAV_REF.fn('/quotes/new');}} style={{
                      flex:1, textAlign:"center", padding:"8px 0", borderRadius:8, cursor:"pointer",
                      border:"none", background:C.goldPale, color:"#8A6D1F", fontSize:12.5, fontWeight:600,
                      fontFamily:"'DM Sans',sans-serif",
                    }}>Teklif Oluştur</button>
                  </div>
                )}
              </MobileEntityCard>
            );
          })}
        </div>
      )}

      {showNew && <NewLeadModal onClose={()=>setShowNew(false)} onSuccess={()=>setShowNew(false)}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE RESERVATIONS — operational cards. Status is legible at a
   glance (confirmed / guide missing / payment pending) without opening
   the record; no secondary metadata competing for attention.
   ══════════════════════════════════════════════════════════════════════ */
function MobileReservationsPage({ onSelect }) {
  const [filter, setFilter] = useState("Yaklaşan");
  const { data:repoRes, loading } = useRepo("reservation", "getAll");
  const [showNew, setShowNew] = useState(false);

  const all = repoRes ?? [];
  const FILTERS = ["Yaklaşan","Bugün","Sorunlu","Tümü"];
  const filtered = all.filter(r => {
    if (filter === "Tümü") return true;
    if (filter === "Bugün") return r.date === _TODAY_STR || r.checkIn === _TODAY_ISO;
    if (filter === "Sorunlu") return !r.guide || r.payStatus === "Bekliyor" || !r.pickup;
    return !["Tamamlandı","İptal"].includes(r.opStatus);
  });

  const OP_TONE = { "Onaylandı":"good", "Rehber Atandı":"good", "Hazırlanıyor":"warn", "Tur Günü":"info", "Tamamlandı":"neutral", "İptal":"bad" };
  const PAY_TONE = { "Ödendi":"good", "Kapora Ödendi":"warn", "Kısmi Ödendi":"warn", "Bekliyor":"bad", "Gecikmiş":"bad", "İade Edildi":"neutral" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
        <div style={{ fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>Rezervasyonlar</div>
        <button onClick={()=>setShowNew(true)} style={{
          display:"flex", alignItems:"center", gap:6, padding:"9px 14px", borderRadius:10,
          border:"none", background:C.navy, color:C.white, cursor:"pointer",
          fontSize:13, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
        }}>
          <GIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
          Yeni
        </button>
      </div>

      <div className="rsp-scroll-x" style={{ display:"flex", gap:8 }}>
        {FILTERS.map(f=>(
          <button key={f} onClick={()=>setFilter(f)} style={{
            flexShrink:0, padding:"7px 14px", borderRadius:99, cursor:"pointer",
            border: filter===f ? "none" : `1px solid ${C.border}`,
            background: filter===f ? C.navy : C.white,
            color: filter===f ? C.white : C.textMid,
            fontSize:12.5, fontWeight:500, fontFamily:"'DM Sans',sans-serif",
          }}>{f}</button>
        ))}
      </div>

      {loading ? <LoadingState label="Rezervasyonlar yükleniyor…"/> : filtered.length === 0 ? (
        <MobileEntityCard style={{ textAlign:"center", padding:"36px 16px" }}>
          <div style={{ fontSize:13, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Bu filtre için rezervasyon yok.</div>
        </MobileEntityCard>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {filtered.map(r=>(
            <MobileEntityCard key={r.id} onClick={()=>onSelect(r.id)}
              style={{ borderLeft: !r.guide||r.payStatus==="Bekliyor" ? `3px solid ${C.red}` : `3px solid ${C.green}` }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:6 }}>
                <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                  <span style={{ fontSize:14, fontWeight:700, color:C.navy, fontFamily:"'Playfair Display',serif" }}>{r.time||r.date||"—"}</span>
                </div>
                <MobileStatusChip label={r.opStatus||"—"} tone={OP_TONE[r.opStatus]||"neutral"}/>
              </div>
              <div style={{ fontSize:14, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{r.name || "—"}</div>
              <div style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{r.tour || "—"} · {r.pax||1} kişi</div>
              <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:9, flexWrap:"wrap" }}>
                <MobileStatusChip label={r.guide ? r.guide : "Rehber Atanmadı"} tone={r.guide ? "good" : "bad"}/>
                <MobileStatusChip label={r.payStatus||"—"} tone={PAY_TONE[r.payStatus]||"neutral"}/>
                {!r.pickup && <MobileStatusChip label="Karşılama Eksik" tone="warn"/>}
              </div>
            </MobileEntityCard>
          ))}
        </div>
      )}

      {showNew && <NewReservationModal onClose={()=>setShowNew(false)} onSuccess={()=>setShowNew(false)}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE GUESTS — a clean contact-style list. No UUID, no data-table
   columns; just who they are and how to reach them.
   ══════════════════════════════════════════════════════════════════════ */
function MobileGuestsPage({ onSelectGuest }) {
  const [search, setSearch] = useState("");
  const { data:repoCustomers, loading } = useRepo("customer", "getAll");
  const [showNew, setShowNew] = useState(false);

  const all = repoCustomers ?? [];
  const q = search.toLowerCase();
  const filtered = !q ? all : all.filter(g =>
    (g.name||"").toLowerCase().includes(q) ||
    (g.country||"").toLowerCase().includes(q) ||
    (g.email||"").toLowerCase().includes(q) ||
    (g.phone||"").includes(q)
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
        <div style={{ fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>Misafirler</div>
        <button onClick={()=>setShowNew(true)} style={{
          display:"flex", alignItems:"center", gap:6, padding:"9px 14px", borderRadius:10,
          border:"none", background:C.navy, color:C.white, cursor:"pointer",
          fontSize:13, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
        }}>
          <GIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
          Yeni
        </button>
      </div>

      <div style={{ position:"relative" }}>
        <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:C.textFaint, pointerEvents:"none" }}>
          <GIc d="M21 21l-4.35-4.35 M17 11A6 6 0 105 11a6 6 0 0012 0z" size={14} sw={1.8}/>
        </span>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="İsim, ülke, telefon veya email ara…" style={{
          width:"100%", boxSizing:"border-box", padding:"11px 12px 11px 36px", borderRadius:12,
          border:`1px solid ${C.border}`, background:C.white, fontSize:14, color:C.text,
          fontFamily:"'DM Sans',sans-serif", outline:"none",
        }}/>
      </div>

      {loading ? <LoadingState label="Misafirler yükleniyor…"/> : filtered.length === 0 ? (
        <MobileEntityCard style={{ textAlign:"center", padding:"36px 16px" }}>
          <div style={{ fontSize:13, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Kayıt bulunamadı.</div>
        </MobileEntityCard>
      ) : (
        <MobileEntityCard style={{ padding:0, overflow:"hidden" }}>
          {filtered.map((g,i)=>(
            <div key={g.id} onClick={()=>onSelectGuest(g.id)} style={{
              display:"flex", alignItems:"center", gap:12, padding:"13px 14px", cursor:"pointer",
              borderBottom: i<filtered.length-1 ? `1px solid ${C.borderLight}` : "none",
            }}>
              <div style={{
                width:40, height:40, borderRadius:"50%", flexShrink:0,
                background:"rgba(27,45,79,0.08)", display:"flex", alignItems:"center", justifyContent:"center",
              }}>
                <span style={{ fontSize:13, fontWeight:700, color:C.navy, fontFamily:"'DM Sans',sans-serif" }}>{g.initials}</span>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{g.flag} {g.name}</div>
                <div style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {g.country}{g.country && (g.phone||g.email) ? " · " : ""}{g.phone||g.email||""}
                </div>
              </div>
              <MobileStatusChip label={g.status||"Aktif"} tone={g.status==="Arşiv"?"neutral":"good"}/>
            </div>
          ))}
        </MobileEntityCard>
      )}

      {showNew && <NewGuestModal onClose={()=>setShowNew(false)}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE QUOTES — a status-driven document list.
   ══════════════════════════════════════════════════════════════════════ */
function MobileQuotesPage({ onSelectQuote, onNewQuote }) {
  const [filter, setFilter] = useState("Tümü");
  const { data:repoQuotes, loading } = useRepo("quote", "getAll");

  const all = repoQuotes ?? [];
  const FILTERS = ["Tümü","Taslak","Gönderildi","Görüntülendi","Onaylandı"];
  const filtered = filter==="Tümü" ? all : all.filter(q=>q.status===filter);

  const STATUS_TONE = { "Taslak":"neutral", "Gönderildi":"info", "Görüntülendi":"warn", "Onaylandı":"good", "Reddedildi":"bad" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
        <div style={{ fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>Teklifler</div>
        <button onClick={onNewQuote} style={{
          display:"flex", alignItems:"center", gap:6, padding:"9px 14px", borderRadius:10,
          border:"none", background:C.navy, color:C.white, cursor:"pointer",
          fontSize:13, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
        }}>
          <GIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
          Yeni
        </button>
      </div>

      <div className="rsp-scroll-x" style={{ display:"flex", gap:8 }}>
        {FILTERS.map(f=>(
          <button key={f} onClick={()=>setFilter(f)} style={{
            flexShrink:0, padding:"7px 14px", borderRadius:99, cursor:"pointer",
            border: filter===f ? "none" : `1px solid ${C.border}`,
            background: filter===f ? C.navy : C.white,
            color: filter===f ? C.white : C.textMid,
            fontSize:12.5, fontWeight:500, fontFamily:"'DM Sans',sans-serif",
          }}>{f}</button>
        ))}
      </div>

      {loading ? <LoadingState label="Teklifler yükleniyor…"/> : filtered.length === 0 ? (
        <MobileEntityCard style={{ textAlign:"center", padding:"36px 16px" }}>
          <div style={{ fontSize:13, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Bu filtre için teklif yok.</div>
        </MobileEntityCard>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {filtered.map(q=>(
            <MobileEntityCard key={q.id} onClick={()=>onSelectQuote(q.id)}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8, marginBottom:6 }}>
                <div style={{ fontSize:14.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{q.flag} {q.customer || "—"}</div>
                <MobileStatusChip label={q.status} tone={STATUS_TONE[q.status]||"neutral"}/>
              </div>
              <div style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>{q.tour}</div>
              <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginTop:8 }}>
                <span style={{ fontSize:17, fontWeight:700, color:C.gold, fontFamily:"'Playfair Display',serif" }}>
                  {q.currency==="TRY"?"₺":"€"}{q.total.toLocaleString("tr-TR")}
                </span>
                <span style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>
                  {q.createdAt && `Gönderim: ${q.createdAt}`}{q.validUntil && ` · Geçerlilik: ${q.validUntil}`}
                </span>
              </div>
            </MobileEntityCard>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE PAYMENTS — unpaid/overdue first. Pending and Collected are
   visually separate groups, not just filterable together.
   ══════════════════════════════════════════════════════════════════════ */
function MobilePaymentsPage() {
  const { data:repoPays, loading } = useRepo("payment", "getAll");
  const { mutate:mutPay, mutating } = useRepoMutation("payment");
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const all = repoPays ?? [];
  const pending = all.filter(p => ["Bekliyor","Kısmi Ödendi","Gecikmiş"].includes(p.status))
    .sort((a,b)=>(a.dueDate||"").localeCompare(b.dueDate||""));
  const collected = all.filter(p => ["Ödendi","Kapora Ödendi"].includes(p.status));

  const STATUS_TONE = { "Bekliyor":"bad", "Gecikmiş":"bad", "Kısmi Ödendi":"warn", "Kapora Ödendi":"warn", "Ödendi":"good", "İade Edildi":"neutral" };

  async function markPaid(p) {
    setBusyId(p.id);
    const { error } = await mutPay("update", p.id, { status:"paid" });
    setBusyId(null);
    if (error) showToast("Güncellenemedi: " + error);
    else showToast("Ödeme tamamlandı olarak işaretlendi ✓");
  }

  function PayRow({ p, showMarkPaid }) {
    return (
      <MobileEntityCard key={p.id}>
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8, marginBottom:6 }}>
          <div style={{ fontSize:14, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{p.customerName || "—"}</div>
          <MobileStatusChip label={p.status} tone={STATUS_TONE[p.status]||"neutral"}/>
        </div>
        <div style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>{p.resRef || "—"}</div>
        <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginTop:8 }}>
          <span style={{ fontSize:17, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>
            {p.currency==="TRY"?"₺":"€"}{p.amount.toLocaleString("tr-TR")}
          </span>
          {p.dueDate && <span style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Vade: {p.dueDate}</span>}
        </div>
        {showMarkPaid && (
          <button onClick={()=>markPaid(p)} disabled={mutating && busyId===p.id} style={{
            width:"100%", marginTop:10, padding:"9px 0", borderRadius:9, border:"none", cursor:"pointer",
            background:C.greenBg, color:C.green, fontSize:12.5, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
          }}>{busyId===p.id ? "İşleniyor…" : "Ödendi Olarak İşaretle"}</button>
        )}
      </MobileEntityCard>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
        <div style={{ fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>Ödemeler</div>
        <button onClick={()=>setShowNew(true)} style={{
          display:"flex", alignItems:"center", gap:6, padding:"9px 14px", borderRadius:10,
          border:"none", background:C.navy, color:C.white, cursor:"pointer",
          fontSize:13, fontWeight:600, fontFamily:"'DM Sans',sans-serif",
        }}>
          <GIc d="M12 5v14M5 12h14" size={14} sw={2.5} color="#fff"/>
          Ödeme Ekle
        </button>
      </div>

      {loading ? <LoadingState label="Ödemeler yükleniyor…"/> : (
        <>
          <MobileSection title={`Bekleyen (${pending.length})`}>
            {pending.length===0 ? (
              <MobileEntityCard style={{ textAlign:"center", padding:"24px 16px" }}>
                <div style={{ fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Bekleyen ödeme yok 🎉</div>
              </MobileEntityCard>
            ) : pending.map(p=><PayRow key={p.id} p={p} showMarkPaid/>)}
          </MobileSection>

          <MobileSection title={`Tahsil Edilen (${collected.length})`}>
            {collected.length===0 ? (
              <MobileEntityCard style={{ textAlign:"center", padding:"24px 16px" }}>
                <div style={{ fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Henüz tahsilat yok.</div>
              </MobileEntityCard>
            ) : collected.map(p=><PayRow key={p.id} p={p}/>)}
          </MobileSection>
        </>
      )}

      {showNew && <NewPaymentModal onClose={()=>setShowNew(false)}/>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE TASKS QUEUE — Tasks and Reminders stay separate backend
   entities (separate tables, separate toggle() calls), but mobile
   presents them as one "things to do" work queue, grouped by urgency.
   ══════════════════════════════════════════════════════════════════════ */
function MobileTasksQueuePage() {
  const { data:repoTasks, loading:lt } = useRepo("task", "getAll");
  const { data:repoRems,  loading:lr } = useRepo("reminder", "getAll");
  const { mutate:mutTask } = useRepoMutation("task");
  const { mutate:mutRem }  = useRepoMutation("reminder");
  const [busyKey, setBusyKey] = useState(null);

  const items = [
    ...(repoTasks ?? []).filter(t=>t.status!=="Tamamlandı").map(t=>({...t, kind:"task"})),
    ...(repoRems  ?? []).filter(r=>r.status!=="Tamamlandı").map(r=>({...r, kind:"reminder"})),
  ].sort((a,b)=>(a.dueDateRaw||0)-(b.dueDateRaw||0));

  const now = Date.now();
  const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
  const endOfToday = new Date(); endOfToday.setHours(23,59,59,999);
  const overdue  = items.filter(i=>i.dueDateRaw && i.dueDateRaw < startOfToday.getTime());
  const today    = items.filter(i=>i.dueDateRaw && i.dueDateRaw >= startOfToday.getTime() && i.dueDateRaw <= endOfToday.getTime());
  const upcoming = items.filter(i=>!i.dueDateRaw || i.dueDateRaw > endOfToday.getTime());

  const PRIORITY_TONE = { "Acil":"bad", "Yüksek":"warn", "Orta":"info", "Düşük":"neutral" };

  async function complete(item) {
    setBusyKey(item.kind+item.id);
    const mutate = item.kind==="task" ? mutTask : mutRem;
    const { error } = await mutate("toggle", item.id);
    setBusyKey(null);
    if (error) showToast("Güncellenemedi: " + error);
    else showToast("Tamamlandı ✓");
  }

  function QueueGroup({ label, list, tone }) {
    if (list.length===0) return null;
    return (
      <MobileSection title={`${label} (${list.length})`}>
        {list.map(item=>(
          <MobileEntityCard key={item.kind+item.id} style={{ borderLeft: tone ? `3px solid ${C.red}` : undefined }}>
            <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
              <button onClick={()=>complete(item)} disabled={busyKey===item.kind+item.id} style={{
                width:24, height:24, borderRadius:"50%", flexShrink:0, marginTop:1,
                border:`1.5px solid ${C.border}`, background:C.white, cursor:"pointer", padding:0,
              }} aria-label="Tamamla"/>
              <div style={{ minWidth:0, flex:1 }}>
                <div style={{ fontSize:13.5, fontWeight:500, color:C.text, fontFamily:"'DM Sans',sans-serif", lineHeight:1.35 }}>{item.title}</div>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:6, flexWrap:"wrap" }}>
                  <MobileStatusChip label={item.kind==="task"?"Görev":"Hatırlatma"} tone="neutral"/>
                  <MobileStatusChip label={item.priority} tone={PRIORITY_TONE[item.priority]||"neutral"}/>
                  {item.dueDate && item.dueDate!=="—" && <span style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{item.dueDate}</span>}
                </div>
              </div>
            </div>
          </MobileEntityCard>
        ))}
      </MobileSection>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>Yapılacaklar</div>

      {(lt||lr) ? <LoadingState label="Yükleniyor…"/> : items.length===0 ? (
        <MobileEntityCard style={{ textAlign:"center", padding:"36px 16px" }}>
          <div style={{ fontSize:13, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Bekleyen görev veya hatırlatma yok 🎉</div>
        </MobileEntityCard>
      ) : (
        <>
          <QueueGroup label="Gecikmiş" list={overdue} tone/>
          <QueueGroup label="Bugün" list={today}/>
          <QueueGroup label="Yaklaşan" list={upcoming}/>
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE DETAIL PRIMITIVES — a small back-row header and a label/value
   line, shared by every Mobile*DetailPage below so identity, contact
   actions and record data are laid out consistently without each detail
   page reinventing chrome.
   ══════════════════════════════════════════════════════════════════════ */
function MobileDetailHeader({ onBack, chip }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
      <button onClick={onBack} style={{
        display:"flex", alignItems:"center", gap:5, flexShrink:0,
        border:"none", background:"transparent", cursor:"pointer", padding:"6px 6px 6px 0",
        color:C.navy, fontSize:14, fontWeight:500, fontFamily:"'DM Sans',sans-serif",
      }}>
        <GIc d="M15 18l-6-6 6-6" size={16} sw={2.2}/>
        Geri
      </button>
      {chip}
    </div>
  );
}

function MobileInfoLine({ label, value, mono, bold, warn }) {
  return (
    <div style={{
      display:"flex", justifyContent:"space-between", alignItems:"center", gap:10,
      padding:"9px 0", borderBottom:`1px solid ${C.borderLight}`,
    }}>
      <span style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{label}</span>
      <span style={{
        fontSize: bold ? 15 : 13, fontWeight: bold ? 700 : 500,
        color: warn ? C.red : C.text,
        fontFamily: mono ? "'DM Mono',monospace" : (bold ? "'Playfair Display',serif" : "'DM Sans',sans-serif"),
        textAlign:"right", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"65%",
      }}>{value}</span>
    </div>
  );
}

function MobileEmptyNote({ text }) {
  return (
    <MobileEntityCard style={{ textAlign:"center", padding:"20px 16px" }}>
      <div style={{ fontSize:12.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{text}</div>
    </MobileEntityCard>
  );
}

/* Generic bottom sheet for a single-choice pick (e.g. status change) —
   the "bottom sheet" interaction pattern used across the mobile surface. */
function MobileStatusSheet({ title, options, current, onSelect, onClose }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div style={{ position:"fixed", inset:0, zIndex:1200, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
      <div onClick={onClose} style={{ position:"absolute", inset:0, background:"rgba(13,27,62,0.42)" }}/>
      <div style={{
        position:"relative", background:C.white, borderRadius:"16px 16px 0 0",
        padding:`6px 0 calc(10px + env(safe-area-inset-bottom, 0px))`,
        maxHeight:"70vh", overflowY:"auto",
      }}>
        <div style={{ width:36, height:4, borderRadius:99, background:C.border, margin:"6px auto 12px" }}/>
        <div style={{ padding:"0 20px 10px", fontSize:14.5, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>{title}</div>
        {options.map(o=>(
          <button key={o} onClick={()=>onSelect(o)} style={{
            width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
            padding:"13px 20px", border:"none", background: o===current ? C.goldPale : "transparent",
            cursor:"pointer", textAlign:"left", fontSize:14, color:C.text, fontFamily:"'DM Sans',sans-serif",
          }}>
            {o}
            {o===current && <GIc d="M20 6L9 17l-5-5" size={15} sw={2.3} color={C.gold}/>}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE CALENDAR — a genuine operations agenda, not the desktop weekly
   grid shrunk down. Sticky compact date header (Today / prev / next / a
   7-day picker strip), a vertical list of touch-friendly tour cards for
   the selected day, and the desktop sidebar's "what needs attention"
   counts folded directly into the header instead of living in a panel
   that has nowhere to go on a phone. Month view is one tap away, via the
   existing MonthlyView grid, but is never the page mobile opens on.
   ══════════════════════════════════════════════════════════════════════ */
function MobileAgendaCard({ ev, onClick }) {
  const col = CAL_OP_COLOR[ev.opStatus] || CAL_OP_COLOR["Hazırlanıyor"];
  const OP_TONE = { "Hazırlanıyor":"neutral", "Rehber Atandı":"info", "Hazır":"gold", "Tamamlandı":"neutral", "İptal":"bad" };
  return (
    <MobileEntityCard onClick={onClick} style={{ borderLeft:`4px solid ${col.border}` }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:6 }}>
        <span style={{ fontSize:15, fontWeight:700, color:C.navy, fontFamily:"'Playfair Display',serif" }}>{fmtHHMM(ev.date)}</span>
        {ev.opStatus && <MobileStatusChip label={ev.opStatus} tone={OP_TONE[ev.opStatus]||"neutral"}/>}
      </div>
      <div style={{ fontSize:14.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{ev.flag} {ev.guest}</div>
      <div style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{ev.tour} · {ev.pax} kişi</div>
      <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:9, flexWrap:"wrap" }}>
        <MobileStatusChip label={ev.guideOk ? `Rehber: ${ev.guide}` : "Rehber Atanmadı"} tone={ev.guideOk?"good":"bad"}/>
        <MobileStatusChip label={ev.pickup || "Pickup Eksik"} tone={ev.pickup?"neutral":"warn"}/>
        <MobileStatusChip label={ev.payStatus || "—"} tone={ev.payStatus==="Ödeme Bekliyor"?"bad":ev.payStatus==="Kapora Ödendi"?"warn":"good"}/>
      </div>
    </MobileEntityCard>
  );
}

function MobileCalendarPage({ navigate }) {
  const [dayOffset, setDayOffset] = useState(0);
  const [showMonth, setShowMonth] = useState(false);
  const events = useCalendarEvents();

  const currentDay = new Date(CAL_TODAY);
  currentDay.setDate(currentDay.getDate() + dayOffset);

  const dow = (currentDay.getDay() + 6) % 7; // Mon=0
  const weekStart = new Date(currentDay);
  weekStart.setDate(currentDay.getDate() - dow);
  const weekDays = Array.from({ length:7 }, (_,i) => { const d=new Date(weekStart); d.setDate(d.getDate()+i); return d; });

  const weekEvents = events.filter(e => {
    const d = new Date(e.date); d.setHours(0,0,0,0);
    const ws = new Date(weekStart); ws.setHours(0,0,0,0);
    const we = new Date(weekStart); we.setDate(we.getDate()+6); we.setHours(23,59,59,0);
    return d >= ws && d <= we;
  });
  const noGuideWeek  = weekEvents.filter(e => !e.guideOk && e.opStatus !== "Tamamlandı").length;
  const noPayWeek    = weekEvents.filter(e => e.payStatus === "Ödeme Bekliyor").length;
  const noPickupWeek = weekEvents.filter(e => !e.pickup && e.opStatus !== "Tamamlandı").length;

  const dayEvents = events.filter(e => isSameDay(e.date, currentDay)).sort((a,b)=>a.date-b.date);
  const monthStart = new Date(currentDay.getFullYear(), currentDay.getMonth(), 1);

  function jumpTo(d) { setDayOffset(Math.round((new Date(d.getFullYear(),d.getMonth(),d.getDate()) - new Date(CAL_TODAY.getFullYear(),CAL_TODAY.getMonth(),CAL_TODAY.getDate())) / 86400000)); }
  function selectDayFromMonth(d) { jumpTo(d); setShowMonth(false); }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      {}
      <div style={{
        position:"sticky", top:0, zIndex:5, background:C.ivory,
        margin:"-14px -12px 0", padding:"14px 12px 12px",
        display:"flex", flexDirection:"column", gap:12,
        borderBottom:`1px solid ${C.borderLight}`,
      }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:19, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif", textTransform:"capitalize" }}>
              {isToday(currentDay) ? "Bugün" : currentDay.toLocaleDateString("tr-TR",{ weekday:"long" })}
            </div>
            <div style={{ fontSize:12, color:C.textMuted, fontFamily:"'DM Sans',sans-serif" }}>
              {currentDay.toLocaleDateString("tr-TR",{ day:"numeric", month:"long", year:"numeric" })}
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
            {!isToday(currentDay) && (
              <button onClick={()=>setDayOffset(0)} style={{
                padding:"7px 12px", borderRadius:8, border:`1px solid ${C.border}`, background:C.white,
                color:C.navy, fontSize:12.5, fontWeight:600, fontFamily:"'DM Sans',sans-serif", cursor:"pointer",
              }}>Bugün</button>
            )}
            <button onClick={()=>setDayOffset(o=>o-1)} aria-label="Önceki gün" style={{
              width:34, height:34, borderRadius:8, border:`1px solid ${C.border}`, background:C.white,
              display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:C.textMid,
            }}><GIc d="M15 18l-6-6 6-6" size={14} sw={2.2}/></button>
            <button onClick={()=>setDayOffset(o=>o+1)} aria-label="Sonraki gün" style={{
              width:34, height:34, borderRadius:8, border:`1px solid ${C.border}`, background:C.white,
              display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:C.textMid,
            }}><GIc d="M9 18l6-6-6-6" size={14} sw={2.2}/></button>
            <button onClick={()=>setShowMonth(s=>!s)} aria-label="Ay görünümü" style={{
              width:34, height:34, borderRadius:8, border:`1px solid ${showMonth?C.gold:C.border}`,
              background: showMonth ? C.goldPale : C.white,
              display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer",
              color: showMonth ? "#8A6D1F" : C.textMid,
            }}><GIc d="M8 2v4M16 2v4M3 10h18M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z" size={14} sw={1.9}/></button>
          </div>
        </div>

        {}
        <div className="rsp-scroll-x" style={{ display:"flex", gap:5 }}>
          {weekDays.map((d,i)=>{
            const active = isSameDay(d, currentDay);
            const has = events.some(e=>isSameDay(e.date,d));
            return (
              <button key={i} onClick={()=>jumpTo(d)} style={{
                flex:"1 0 auto", minWidth:42, display:"flex", flexDirection:"column", alignItems:"center", gap:3,
                padding:"7px 4px", borderRadius:10, border:"none", cursor:"pointer",
                background: active ? C.navy : "transparent",
              }}>
                <span style={{ fontSize:9.5, fontWeight:600, color: active?"rgba(248,245,238,0.65)":C.textFaint, fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase" }}>{fmtDayShort(d)}</span>
                <span style={{ fontSize:13.5, fontWeight:700, color: active?C.white:isToday(d)?C.gold:C.text, fontFamily:"'DM Sans',sans-serif" }}>{fmtDayNum(d)}</span>
                <span style={{ width:4, height:4, borderRadius:"50%", background: has ? (active?C.goldLight:C.gold) : "transparent" }}/>
              </button>
            );
          })}
        </div>

        {}
        {(noGuideWeek>0 || noPayWeek>0 || noPickupWeek>0) && (
          <div className="rsp-scroll-x" style={{ display:"flex", gap:8 }}>
            {noGuideWeek>0  && <MobileStatusChip label={`${noGuideWeek} rehber eksik (bu hafta)`} tone="bad"/>}
            {noPayWeek>0    && <MobileStatusChip label={`${noPayWeek} ödeme bekliyor (bu hafta)`} tone="warn"/>}
            {noPickupWeek>0 && <MobileStatusChip label={`${noPickupWeek} pickup eksik (bu hafta)`} tone="warn"/>}
          </div>
        )}
      </div>

      {showMonth && (
        <MonthlyView monthStart={monthStart} events={events} onSelectDay={selectDayFromMonth} isMobile/>
      )}

      {}
      {dayEvents.length === 0 ? (
        <MobileEntityCard style={{ textAlign:"center", padding:"44px 16px" }}>
          <div style={{ fontSize:28, marginBottom:10, opacity:.3 }}>🗓️</div>
          <div style={{ fontSize:13.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Bu gün için planlanmış tur yok.</div>
        </MobileEntityCard>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {dayEvents.map(ev => (
            <MobileAgendaCard key={ev.id} ev={ev} onClick={()=>{
              const target = ev.resId || ev.id;
              if (target && navigate) navigate('/reservations/'+target);
            }}/>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE GUEST DETAIL — a CRM contact page: identity and contact actions
   first, then requests/reservations/quotes/payments/notes as independent
   sections, each backed by the same per-customer repo lookups the
   desktop page would use (getByCustomerId on every entity). Deliberately
   does not depend on the mock-only enrichCustomer() helper the desktop
   GuestDetailPage uses, which never resolves real Supabase records.
   ══════════════════════════════════════════════════════════════════════ */
function MobileGuestDetailPage({ guestId, onBack }) {
  const _sp = safeParam(guestId);
  if (_sp.invalid) return <NotFoundCard entityType="Misafir" entityId={guestId} onBack={onBack}/>;

  const { data:g, loading, error } = useRepo("customer", "getById", guestId);
  const { data:leads }   = useRepo("lead",        "getByCustomerId", guestId);
  const { data:quotes }  = useRepo("quote",       "getByCustomerId", guestId);
  const { data:resList } = useRepo("reservation", "getByCustomerId", guestId);
  const { data:pays }    = useRepo("payment",     "getByCustomerId", guestId);

  if (loading) return <LoadingState label="Misafir profili yükleniyor…"/>;
  if (error)   return <ErrorState message={error} onRetry={()=>{}}/>;
  if (!g)      return <NotFoundCard entityType="Misafir" entityId={guestId} onBack={onBack}/>;

  const openLeads = (leads||[]).filter(l => !["Onaylandı","İptal"].includes(l.status));
  const today = new Date(); today.setHours(0,0,0,0);
  const upcomingRes = (resList||[]).filter(r => r.opStatus !== "İptal" && (!r.checkIn || new Date(r.checkIn) >= today));

  const LEAD_TONE = { "Yeni":"info", "Görüşüldü":"neutral", "Teklif Hazırlanıyor":"neutral", "Teklif Gönderildi":"warn", "Teklif Onaylandı":"good", "Onaylandı":"good", "İptal":"bad", "Beklemede":"neutral" };
  const QUOTE_TONE = { "Taslak":"neutral", "Gönderildi":"info", "Onaylandı":"good", "İptal":"bad", "Süresi Doldu":"neutral" };
  const PAY_TONE = { "Bekliyor":"bad", "Gecikmiş":"bad", "Kısmi Ödendi":"warn", "Kapora Ödendi":"warn", "Ödendi":"good", "İade Edildi":"neutral" };
  const waHref = g.phone ? `https://wa.me/${String(g.phone).replace(/[^0-9]/g,'')}` : null;

  const contactBtn = (href, label, disabled) => (
    <a href={disabled?undefined:href} target={href&&href.startsWith('http')?"_blank":undefined} rel="noreferrer" style={{
      display:"flex", alignItems:"center", justifyContent:"center", padding:"10px 0", borderRadius:10,
      border:`1px solid ${C.border}`, background:C.white, color: disabled?C.textFaint:C.navy,
      fontSize:12.5, fontWeight:600, fontFamily:"'DM Sans',sans-serif", textDecoration:"none",
      opacity: disabled?0.5:1, cursor: disabled?"default":"pointer",
    }}>{label}</a>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
      <MobileDetailHeader onBack={onBack}/>

      <MobileEntityCard style={{ padding:0, overflow:"hidden" }}>
        <div style={{ background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`, padding:"22px 18px 18px", display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ width:56, height:56, borderRadius:"50%", flexShrink:0, background:"rgba(201,168,76,0.18)", border:"2px solid rgba(201,168,76,0.4)", display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ fontSize:20, fontWeight:700, color:C.goldLight, fontFamily:"'Playfair Display',serif" }}>{g.initials}</span>
          </div>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:18, fontWeight:700, color:C.ivory, fontFamily:"'Playfair Display',serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{g.flag} {g.name}</div>
            <div style={{ fontSize:12.5, color:"rgba(248,245,238,0.6)", fontFamily:"'DM Sans',sans-serif", marginTop:3 }}>
              {[g.country, g.language].filter(Boolean).join(" · ") || "—"}
            </div>
          </div>
        </div>
        <div style={{ padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <MobileStatusChip label={g.status||"Aktif"} tone={g.status==="Arşiv"?"neutral":"good"}/>
          {g.firstContact && <span style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>{g.firstContact}'dan beri</span>}
        </div>
      </MobileEntityCard>

      {}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
        {contactBtn(g.phone?`tel:${g.phone}`:null, "Ara", !g.phone)}
        {contactBtn(waHref, "WhatsApp", !g.phone)}
        {contactBtn(g.email?`mailto:${g.email}`:null, "E-posta", !g.email)}
      </div>

      {(g.phone || g.email) && (
        <MobileEntityCard>
          {g.phone && <MobileInfoLine label="Telefon" value={g.phone} mono/>}
          {g.email && <MobileInfoLine label="E-posta" value={g.email} mono/>}
        </MobileEntityCard>
      )}

      <MobileSection title={`Aktif Talepler (${openLeads.length})`}>
        {openLeads.length===0 ? <MobileEmptyNote text="Açık talep yok."/> : openLeads.map(l=>(
          <MobileEntityCard key={l.id} onClick={()=>NAV_REF.fn && NAV_REF.fn('/leads/'+l.id)}>
            <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
              <div style={{ fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{l.tour || "Deneyim belirtilmedi"}</div>
              <MobileStatusChip label={l.status} tone={LEAD_TONE[l.status]||"neutral"}/>
            </div>
            <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:3 }}>{l.dateRange || l.ago}</div>
          </MobileEntityCard>
        ))}
      </MobileSection>

      <MobileSection title={`Yaklaşan Rezervasyonlar (${upcomingRes.length})`}>
        {upcomingRes.length===0 ? <MobileEmptyNote text="Yaklaşan rezervasyon yok."/> : upcomingRes.map(r=>(
          <MobileEntityCard key={r.id} onClick={()=>NAV_REF.fn && NAV_REF.fn('/reservations/'+r.id)}>
            <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
              <div style={{ fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{r.tour}</div>
              <MobileStatusChip label={r.opStatus} tone={r.opStatus==="Tamamlandı"?"neutral":r.opStatus==="İptal"?"bad":"good"}/>
            </div>
            <div style={{ fontSize:11.5, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:3 }}>{r.date} · {r.pax} kişi</div>
          </MobileEntityCard>
        ))}
      </MobileSection>

      <MobileSection title={`Teklifler (${(quotes||[]).length})`}>
        {(quotes||[]).length===0 ? <MobileEmptyNote text="Teklif yok."/> : (quotes||[]).map(q=>(
          <MobileEntityCard key={q.id} onClick={()=>NAV_REF.fn && NAV_REF.fn('/quotes/'+q.id)}>
            <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
              <div style={{ fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{q.tour}</div>
              <MobileStatusChip label={q.status} tone={QUOTE_TONE[q.status]||"neutral"}/>
            </div>
            <div style={{ fontSize:13.5, fontWeight:700, color:C.gold, fontFamily:"'Playfair Display',serif", marginTop:4 }}>{q.currency==="TRY"?"₺":"€"}{q.total.toLocaleString("tr-TR")}</div>
          </MobileEntityCard>
        ))}
      </MobileSection>

      <MobileSection title={`Ödeme Geçmişi (${(pays||[]).length})`}>
        {(pays||[]).length===0 ? <MobileEmptyNote text="Ödeme kaydı yok."/> : (pays||[]).map(p=>(
          <MobileEntityCard key={p.id}>
            <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
              <div style={{ fontSize:13.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{p.paymentType}</div>
              <MobileStatusChip label={p.status} tone={PAY_TONE[p.status]||"neutral"}/>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginTop:5 }}>
              <span style={{ fontSize:14, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>{p.currency==="TRY"?"₺":"€"}{p.amount.toLocaleString("tr-TR")}</span>
              {p.dueDate && <span style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Vade: {p.dueDate}</span>}
            </div>
          </MobileEntityCard>
        ))}
      </MobileSection>

      {g.notes && (
        <MobileSection title="Notlar">
          <MobileEntityCard><div style={{ fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif", lineHeight:1.6 }}>{g.notes}</div></MobileEntityCard>
        </MobileSection>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE LEAD DETAIL — guest, requested tour/date, source, status and
   assignee up front; the two things a salesperson actually does from a
   phone (call the guest, create a quote) are one tap away, and status
   changes go through mutLead("update", …) exactly like the desktop page.
   ══════════════════════════════════════════════════════════════════════ */
function MobileLeadDetailPage({ leadId, onBack }) {
  const _sp = safeParam(leadId);
  if (_sp.invalid) return <NotFoundCard entityType="Talep" entityId={leadId} onBack={onBack}/>;

  const { data:lead, loading, error } = useRepo("lead", "getById", leadId);
  const { sources } = useSources();
  const { data:staffList } = useRepo("staff", "getAll");
  const { mutate:mutLead, mutating } = useRepoMutation("lead");
  const [showStatus, setShowStatus] = useState(false);

  if (loading) return <LoadingState label="Talep yükleniyor…"/>;
  if (error)   return <ErrorState message={error} onRetry={()=>{}}/>;
  if (!lead)   return <NotFoundCard entityType="Talep" entityId={leadId} onBack={onBack}/>;

  const srcLabel  = (sources||[]).find(s=>s.id===lead.sourceId)?.name || "Belirtilmedi";
  const assignee  = (staffList||[]).find(s=>s.id===lead.assigneeId);
  const STATUS_TONE = { "Yeni":"info", "Görüşüldü":"neutral", "Teklif Hazırlanıyor":"neutral", "Teklif Gönderildi":"warn", "Teklif Onaylandı":"good", "Onaylandı":"good", "İptal":"bad", "Beklemede":"neutral" };
  const STATUS_OPTIONS = ["Yeni","Görüşüldü","Teklif Hazırlanıyor","Teklif Gönderildi","Teklif Onaylandı","Onaylandı","Beklemede","İptal"];

  async function setStatus(s) {
    setShowStatus(false);
    const { error } = await mutLead("update", lead.id, { status:s });
    if (error) showToast("Güncellenemedi: " + error);
    else showToast("Durum güncellendi ✓");
  }

  function createQuote() {
    // Same prefill shape QuickActionsCard uses for the desktop builder —
    // MobileNewQuotePage reads SESSION.getPrefill() the same way.
    SESSION.setPrefill({
      fromLead:lead.id, guestName:lead.name, email:lead.email, phone:lead.phone,
      tourName:lead.tour, tourDate:lead.dateRange, guestCount:lead.paxAdult,
    });
    NAV_REF.fn && NAV_REF.fn('/quotes/new');
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:18, paddingBottom:64 }}>
      <MobileDetailHeader onBack={onBack} chip={<MobileStatusChip label={lead.status} tone={STATUS_TONE[lead.status]||"neutral"}/>}/>

      <MobileEntityCard>
        <div style={{ fontSize:18, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>{lead.name}</div>
        <div style={{ fontSize:13, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:3 }}>{lead.tour || "Deneyim belirtilmedi"}</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:10 }}>
          {lead.dateRange && <MobileStatusChip label={`📅 ${lead.dateRange}`} tone="neutral"/>}
          <MobileStatusChip label={srcLabel} tone="neutral"/>
          <MobileStatusChip label={`${lead.paxAdult||1} kişi`} tone="neutral"/>
        </div>
      </MobileEntityCard>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        <a href={lead.phone?`tel:${lead.phone}`:undefined} style={{
          display:"flex", alignItems:"center", justifyContent:"center", padding:"11px 0", borderRadius:10,
          border:`1px solid ${C.border}`, background:C.white, color: lead.phone?C.navy:C.textFaint,
          fontSize:13, fontWeight:600, fontFamily:"'DM Sans',sans-serif", textDecoration:"none",
          opacity: lead.phone?1:0.5,
        }}>Misafiri Ara</a>
        <button onClick={createQuote} style={{
          display:"flex", alignItems:"center", justifyContent:"center", padding:"11px 0", borderRadius:10,
          border:"none", background:C.goldPale, color:"#8A6D1F", cursor:"pointer",
          fontSize:13, fontWeight:700, fontFamily:"'DM Sans',sans-serif",
        }}>Teklif Oluştur</button>
      </div>

      <MobileSection title="Detaylar">
        <MobileEntityCard>
          <MobileInfoLine label="Telefon" value={lead.phone||"—"} mono/>
          <MobileInfoLine label="E-posta" value={lead.email||"—"} mono/>
          <MobileInfoLine label="Görevli" value={assignee?.name || "Atanmadı"}/>
          <MobileInfoLine label="Oluşturulma" value={lead.ago||"—"}/>
        </MobileEntityCard>
      </MobileSection>

      {lead.notes && (
        <MobileSection title="Notlar">
          <MobileEntityCard><div style={{ fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif", lineHeight:1.6 }}>{lead.notes}</div></MobileEntityCard>
        </MobileSection>
      )}

      <MobileActionBar aboveTabBar>
        <button onClick={()=>setShowStatus(true)} disabled={mutating} style={{
          flex:1, padding:"13px 0", borderRadius:12, border:"none", cursor:"pointer",
          background:C.navy, color:C.white, fontSize:14, fontWeight:700, fontFamily:"'DM Sans',sans-serif",
        }}>Durumu Güncelle</button>
      </MobileActionBar>

      {showStatus && (
        <MobileStatusSheet title="Durumu Güncelle" options={STATUS_OPTIONS} current={lead.status}
          onSelect={setStatus} onClose={()=>setShowStatus(false)}/>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE QUOTE DETAIL — a status-driven document, not a two-column
   builder squeezed onto a phone. Send / Resend / Approve / Convert to
   Reservation are wired to the real repos (quote update, reservation
   create) rather than the desktop page's action list, part of which
   calls a handler that only exists in a different component.
   ══════════════════════════════════════════════════════════════════════ */
function MobileQuoteDetailPage({ quoteId, onBack }) {
  const _sp = safeParam(quoteId);
  if (_sp.invalid) return <NotFoundCard entityType="Teklif" entityId={quoteId} onBack={onBack}/>;

  const { data:q, loading, error } = useRepo("quote", "getById", quoteId);
  const { mutate:mutQuote, mutating:quoteMut } = useRepoMutation("quote");
  const { mutate:mutRes,   mutating:resMut }   = useRepoMutation("reservation");
  const [converting, setConverting] = useState(false);

  if (loading) return <LoadingState label="Teklif yükleniyor…"/>;
  if (error)   return <ErrorState message={error} onRetry={()=>{}}/>;
  if (!q)      return <NotFoundCard entityType="Teklif" entityId={quoteId} onBack={onBack}/>;

  const sym = q.currency==="TRY"?"₺":q.currency==="GBP"?"£":q.currency==="USD"?"$":"€";
  const fmt = n => `${sym}${Number(n||0).toLocaleString("tr-TR")}`;
  const STATUS_TONE = { "Taslak":"neutral", "Gönderildi":"info", "Onaylandı":"good", "İptal":"bad", "Süresi Doldu":"neutral" };
  const included = (q.items||[]).filter(i=>i.type==="Dahil");
  const excluded = (q.items||[]).filter(i=>i.type==="Hariç");

  async function send() {
    const { error } = await mutQuote("update", q.id, { status:"Gönderildi" });
    if (error) showToast("Güncellenemedi: " + error);
    else showToast(q.status==="Gönderildi" ? "Teklif tekrar gönderildi ✓" : "Teklif gönderildi ✓");
  }
  async function approve() {
    const { error } = await mutQuote("update", q.id, { status:"Onaylandı" });
    if (error) showToast("Güncellenemedi: " + error);
    else showToast("Teklif onaylandı ✓");
  }
  async function convertToReservation() {
    if (!q.customerId) { showToast("Bu teklifin bağlı bir misafiri yok."); return; }
    setConverting(true);
    const { data:newRes, error } = await mutRes("create", {
      customerId: q.customerId, tourId: q.tourId||null, quoteId: q.id, tour: q.tour,
      checkIn: q.travelStart||null, checkOut: q.travelStart||null,
      pax: q.pax, total: q.total, deposit: q.deposit, currency: q.currency, notes: q.notes||"",
    });
    if (error) { setConverting(false); showToast("Rezervasyona dönüştürülemedi: " + error); return; }
    await mutQuote("update", q.id, { status:"Onaylandı" });
    setConverting(false);
    showToast("Rezervasyon oluşturuldu ✓");
    if (newRes?.id && NAV_REF.fn) NAV_REF.fn('/reservations/'+newRes.id);
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:18, paddingBottom:64 }}>
      <MobileDetailHeader onBack={onBack} chip={<MobileStatusChip label={q.status} tone={STATUS_TONE[q.status]||"neutral"}/>}/>

      <MobileEntityCard style={{ padding:0, overflow:"hidden" }}>
        <div style={{ background:`linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`, padding:"20px 18px" }}>
          <div style={{ fontSize:11, color:"rgba(248,245,238,0.55)", fontFamily:"'DM Sans',sans-serif", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:8 }}>{q.flag} {q.customer || "—"}</div>
          <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
            <span style={{ fontSize:29, fontWeight:700, color:C.goldLight, fontFamily:"'Playfair Display',serif" }}>{fmt(q.total)}</span>
            <span style={{ fontSize:12, color:"rgba(248,245,238,0.5)", fontFamily:"'DM Sans',sans-serif" }}>{q.currency}</span>
          </div>
          <div style={{ fontSize:12, color:"rgba(248,245,238,0.6)", fontFamily:"'DM Sans',sans-serif", marginTop:4 }}>{fmt(q.unitPrice)} × {q.pax} kişi</div>
        </div>
        <div style={{ padding:"12px 18px" }}>
          <div style={{ fontSize:14, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{q.tour}</div>
          <div style={{ fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>
            {q.dateRange}{q.validUntil && ` · Geçerlilik: ${q.validUntil}`}
          </div>
        </div>
      </MobileEntityCard>

      <MobileSection title="Ödeme">
        <MobileEntityCard>
          <MobileInfoLine label="Toplam" value={fmt(q.total)} bold/>
          <MobileInfoLine label="Kapora" value={fmt(q.deposit)}/>
          <MobileInfoLine label="Kalan" value={fmt(q.remaining)}/>
        </MobileEntityCard>
      </MobileSection>

      {included.length>0 && (
        <MobileSection title="Dahil Hizmetler">
          <MobileEntityCard>{included.map((it,i)=><CheckItem key={i} label={it.label} checked={true}/>)}</MobileEntityCard>
        </MobileSection>
      )}
      {excluded.length>0 && (
        <MobileSection title="Dahil Olmayan Hizmetler">
          <MobileEntityCard>{excluded.map((it,i)=><CheckItem key={i} label={it.label} checked={false}/>)}</MobileEntityCard>
        </MobileSection>
      )}

      {q.notes && (
        <MobileSection title="Notlar">
          <MobileEntityCard><div style={{ fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif", lineHeight:1.6 }}>{q.notes}</div></MobileEntityCard>
        </MobileSection>
      )}

      <MobileActionBar aboveTabBar>
        {q.status==="Taslak" && (
          <button onClick={send} disabled={quoteMut} style={{ flex:1, padding:"13px 0", borderRadius:12, border:"none", cursor:"pointer", background:C.navy, color:C.white, fontSize:14, fontWeight:700, fontFamily:"'DM Sans',sans-serif" }}>Gönder</button>
        )}
        {q.status==="Gönderildi" && (
          <>
            <button onClick={send} disabled={quoteMut} style={{ flex:1, padding:"13px 0", borderRadius:12, border:`1px solid ${C.border}`, cursor:"pointer", background:C.white, color:C.textMid, fontSize:13.5, fontWeight:600, fontFamily:"'DM Sans',sans-serif" }}>Tekrar Gönder</button>
            <button onClick={approve} disabled={quoteMut} style={{ flex:1, padding:"13px 0", borderRadius:12, border:"none", cursor:"pointer", background:C.navy, color:C.white, fontSize:14, fontWeight:700, fontFamily:"'DM Sans',sans-serif" }}>Onayla</button>
          </>
        )}
        {q.status==="Onaylandı" && (
          <button onClick={convertToReservation} disabled={converting||resMut} style={{ flex:1, padding:"13px 0", borderRadius:12, border:"none", cursor:"pointer", background:C.navy, color:C.white, fontSize:14, fontWeight:700, fontFamily:"'DM Sans',sans-serif" }}>
            {converting ? "Dönüştürülüyor…" : "Rezervasyona Dönüştür"}
          </button>
        )}
      </MobileActionBar>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE RESERVATION DETAIL — the most operationally important screen:
   missing guide / missing pickup / pending payment must read instantly,
   so they surface as a red warning card above everything else rather
   than as a dot buried in a corner.
   ══════════════════════════════════════════════════════════════════════ */
function MobileReservationDetailPage({ resId, onBack }) {
  const _sp = safeParam(resId);
  if (_sp.invalid) return <NotFoundCard entityType="Rezervasyon" entityId={resId} onBack={onBack}/>;

  const { data:r, loading, error } = useRepo("reservation", "getById", resId);
  const { data:cust } = useRepo("customer", "getById", r?.customerId || null);

  if (loading) return <LoadingState label="Rezervasyon yükleniyor…"/>;
  if (error)   return <ErrorState message={error} onRetry={()=>{}}/>;
  if (!r)      return <NotFoundCard entityType="Rezervasyon" entityId={resId} onBack={onBack}/>;

  const sym = r.currency==="TRY"?"₺":r.currency==="GBP"?"£":r.currency==="USD"?"$":"€";
  const fmt = n => `${sym}${Number(n||0).toLocaleString("tr-TR")}`;
  const OP_TONE  = { "Onaylandı":"good", "Rehber Atandı":"good", "Hazırlanıyor":"warn", "Tur Günü":"info", "Tamamlandı":"neutral", "İptal":"bad" };
  const PAY_TONE = { "Ödendi":"good", "Kapora Ödendi":"warn", "Kısmi Ödendi":"warn", "Bekliyor":"bad", "Gecikmiş":"bad", "İade Edildi":"neutral" };
  const warnings = [];
  if (!r.guide) warnings.push("Rehber atanmadı");
  if (!r.pickup) warnings.push("Pickup bilgisi eksik");
  if (r.payStatus==="Bekliyor" || r.payStatus==="Gecikmiş") warnings.push("Ödeme bekliyor");
  const waHref = cust?.phone ? `https://wa.me/${String(cust.phone).replace(/[^0-9]/g,'')}` : null;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
      <MobileDetailHeader onBack={onBack} chip={<MobileStatusChip label={r.opStatus} tone={OP_TONE[r.opStatus]||"neutral"}/>}/>

      {warnings.length>0 && (
        <MobileEntityCard style={{ borderLeft:`3px solid ${C.red}`, background:C.redBg }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <GIc d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" size={15} sw={1.8} color={C.red}/>
            <span style={{ fontSize:13, fontWeight:700, color:C.red, fontFamily:"'DM Sans',sans-serif" }}>Operasyonel Uyarı</span>
          </div>
          {warnings.map((w,i)=>(
            <div key={i} style={{ fontSize:12.5, color:C.red, fontFamily:"'DM Sans',sans-serif", marginTop:5, paddingLeft:23 }}>• {w}</div>
          ))}
        </MobileEntityCard>
      )}

      <MobileEntityCard>
        <div style={{ fontSize:18, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>{r.name || "—"}</div>
        <div style={{ fontSize:13, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:3 }}>{r.tour}</div>
        <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:10, flexWrap:"wrap" }}>
          <MobileStatusChip label={`📅 ${r.date}`} tone="neutral"/>
          <MobileStatusChip label={`🕐 ${r.time}`} tone="neutral"/>
          <MobileStatusChip label={`${r.pax} kişi`} tone="neutral"/>
        </div>
      </MobileEntityCard>

      {cust?.phone && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
          <a href={`tel:${cust.phone}`} style={{
            display:"flex", alignItems:"center", justifyContent:"center", padding:"11px 0", borderRadius:10,
            border:`1px solid ${C.border}`, background:C.white, color:C.navy,
            fontSize:13, fontWeight:600, fontFamily:"'DM Sans',sans-serif", textDecoration:"none",
          }}>Misafiri Ara</a>
          <a href={waHref} target="_blank" rel="noreferrer" style={{
            display:"flex", alignItems:"center", justifyContent:"center", padding:"11px 0", borderRadius:10,
            border:"none", background:C.goldPale, color:"#8A6D1F",
            fontSize:13, fontWeight:700, fontFamily:"'DM Sans',sans-serif", textDecoration:"none",
          }}>WhatsApp</a>
        </div>
      )}

      <MobileSection title="Operasyon">
        <MobileEntityCard>
          <MobileInfoLine label="Rehber" value={r.guide || "Atanmadı"} warn={!r.guide}/>
          <MobileInfoLine label="Araç" value={r.vehicle || "—"}/>
          <MobileInfoLine label="Şoför" value={r.driver || "—"}/>
          <MobileInfoLine label="Pickup" value={r.pickup || "Belirtilmedi"} warn={!r.pickup}/>
          <MobileInfoLine label="Pickup Saati" value={r.pickupTime || "—"}/>
        </MobileEntityCard>
      </MobileSection>

      <MobileSection title="Ödeme">
        <MobileEntityCard>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10 }}>
            <span style={{ fontSize:21, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>{fmt(r.total)}</span>
            <MobileStatusChip label={r.payStatus} tone={PAY_TONE[r.payStatus]||"neutral"}/>
          </div>
          <MobileInfoLine label="Kapora" value={fmt(r.deposit)}/>
          <MobileInfoLine label="Kalan" value={fmt(r.remaining)}/>
        </MobileEntityCard>
      </MobileSection>

      {r.opNotes && (
        <MobileSection title="Notlar">
          <MobileEntityCard><div style={{ fontSize:13, color:C.textMid, fontFamily:"'DM Sans',sans-serif", lineHeight:1.6 }}>{r.opNotes}</div></MobileEntityCard>
        </MobileSection>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE QUOTE CREATION — a full-screen, five-step wizard (Guest → Tour
   → Date & Guests → Pricing & Inclusions → Review), not the desktop
   builder's two-column form+live-preview squeezed onto a phone. Uses the
   same repos as every other create flow (customer find-or-create, then
   quote create with items) — written fresh rather than reusing
   NewProposalPage, whose own save/convert handlers reference state that
   doesn't exist in its scope and would throw if invoked.
   ══════════════════════════════════════════════════════════════════════ */
function MobileNewQuotePage({ onBack }) {
  // Same SESSION prefill the desktop builder reads (set by QuickActionsCard /
  // MobileLeadDetailPage's "Teklif Oluştur") — consumed once, like there.
  const _pf = SESSION.getPrefill() || {};
  const [step, setStep] = useState(0);
  const [guestName, setGuestName]   = useState(_pf.guestName || "");
  const [phone, setPhone]           = useState(_pf.phone || "");
  const [email, setEmail]           = useState(_pf.email || "");
  const [nationality, setNationality] = useState(_pf.nationality || "");
  const [fromLeadId] = useState(_pf.fromLead || null);
  const { data:tourList } = useRepo("tour", "getAll");
  const [tourId, setTourId]     = useState("");
  const [tourName, setTourName] = useState(_pf.tourName || "");
  const [travelDate, setTravelDate] = useState(_pf.tourDate || "");
  const [guestCount, setGuestCount] = useState(String(_pf.guestCount || 2));
  const [currency, setCurrency]     = useState(_pf.currency || "EUR");
  const [pricePerPerson, setPricePerPerson] = useState(_pf.pricePerPerson ? String(_pf.pricePerPerson) : "");
  const [discountPct, setDiscountPct] = useState("0");
  const [depositPct, setDepositPct]   = useState("25");
  const [included, setIncluded] = useState(DEFAULT_INCLUDED.map(l=>({ label:l, on:true })));
  const [excluded, setExcluded] = useState(DEFAULT_EXCLUDED.map(l=>({ label:l, on:true })));
  const [notes, setNotes] = useState("");
  const [errs, setErrs]   = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const tours = tourList || [];
  const pax   = parseInt(guestCount) || 1;
  const unit  = parseFloat(pricePerPerson) || 0;
  const total = Math.round(unit * pax * (1 - (parseFloat(discountPct)||0) / 100));
  const deposit   = Math.round(total * (parseFloat(depositPct)||25) / 100);
  const remaining = total - deposit;
  const sym = currency==="TRY"?"₺":currency==="GBP"?"£":currency==="USD"?"$":"€";
  const STEPS = ["Misafir","Tur","Tarih & Kişi","Fiyat","Özet"];

  function pickTour(id) {
    setTourId(id);
    const t = tours.find(x=>x.id===id);
    if (t) {
      setTourName(t.name);
      if (!pricePerPerson) setPricePerPerson(String(t.flatPrice||""));
      if (t.currency) setCurrency(t.currency);
    }
  }

  function validateStep(s) {
    const e = {};
    if (s===0 && !guestName.trim()) e.guestName = "Ad Soyad zorunludur";
    if (s===1 && !tourName.trim())  e.tourName  = "Tur seçin veya adını girin";
    if (s===2 && !travelDate)       e.travelDate = "Seyahat tarihi zorunludur";
    if (s===3 && total<=0)          e.pricePerPerson = "Toplam tutar sıfırdan büyük olmalı";
    return e;
  }

  function goBack() {
    if (step===0) { onBack(); return; }
    setStep(s=>s-1);
  }
  function goNext() {
    const e = validateStep(step);
    setErrs(e);
    if (Object.keys(e).length) return;
    if (step < STEPS.length-1) setStep(s=>s+1);
    else save();
  }

  async function save() {
    setSaving(true);
    try {
      const custRepo = getActiveRepo("customer");
      let custId = null;
      const existing = await Promise.resolve(custRepo.findByContact({ email: email||null, phone: phone||null })).catch(()=>null);
      if (existing) {
        custId = existing.id;
      } else {
        const newCust = await Promise.resolve(custRepo.create({
          name: guestName, phone: phone||"", email: email||"",
          country: nationality||"Diğer", language:"İngilizce", importType:"manual",
        }));
        custId = newCust?.id || null;
      }

      const items = [
        ...included.filter(i=>i.on).map((i,idx)=>({ type:"Dahil", label:i.label, quantity:1, unitPrice:0, total:0, sortOrder:idx })),
        ...excluded.filter(i=>i.on).map((i,idx)=>({ type:"Hariç", label:i.label, quantity:1, unitPrice:0, total:0, sortOrder:idx+50 })),
      ];

      const quoteRepo = getActiveRepo("quote");
      const newQuote = await Promise.resolve(quoteRepo.create({
        customerId: custId, leadId: fromLeadId, tourId: tourId||null, tourName, tour: tourName,
        travelStart: travelDate||null, status:"Taslak",
        guestCount: pax, pricePerPerson: unit, currency,
        discountPct: parseFloat(discountPct)||0, total, deposit, notes, items,
      }));

      await autoLog("quote", newQuote?.id || "?", "created", `Teklif oluşturuldu: ${tourName}`);
      showToast("Teklif oluşturuldu ✓");
      if (newQuote?.id && NAV_REF.fn) NAV_REF.fn('/quotes/'+newQuote.id);
      else onBack();
    } catch(err) {
      showToast("Teklif oluşturulamadı: " + (err?.message || err));
    } finally {
      setSaving(false);
    }
  }

  function toggleItem(list, setList, idx) {
    setList(arr => arr.map((x,i)=> i===idx ? { ...x, on: !x.on } : x));
  }

  return (
    <div style={{ position:"fixed", inset:0, zIndex:1000, background:C.ivory, display:"flex", flexDirection:"column" }}>
      {}
      <div style={{
        flexShrink:0, background:C.white, borderBottom:`1px solid ${C.border}`,
        paddingTop:"env(safe-area-inset-top, 0px)",
      }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"calc(10px + env(safe-area-inset-top, 0px)) 8px 8px" }}>
          <button onClick={goBack} style={{ border:"none", background:"transparent", cursor:"pointer", color:C.textMid, fontSize:14.5, fontFamily:"'DM Sans',sans-serif", padding:"8px 10px", minWidth:44 }}>
            {step===0 ? "İptal" : "Geri"}
          </button>
          <div style={{ fontSize:15.5, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>Yeni Teklif</div>
          <div style={{ minWidth:44 }}/>
        </div>
        <div style={{ display:"flex", gap:4, padding:"0 16px 10px" }}>
          {STEPS.map((s,i)=>(<div key={i} style={{ flex:1, height:3, borderRadius:99, background: i<=step ? C.gold : C.borderLight }}/>))}
        </div>
        <div style={{ padding:"0 16px 10px", fontSize:12, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>Adım {step+1}/{STEPS.length} · {STEPS[step]}</div>
      </div>

      {}
      <div style={{ flex:1, overflowY:"auto", padding:"18px 16px 24px" }}>
        {step===0 && (
          <FGrid>
            <FRow label="Ad Soyad" required error={errs.guestName}><FText value={guestName} onChange={setGuestName} placeholder="Sarah Johnson"/></FRow>
            <FRow label="Telefon"><FText value={phone} onChange={setPhone} placeholder="+90 555 000 0000" mono/></FRow>
            <FRow label="E-posta"><FText value={email} onChange={setEmail} placeholder="email@example.com" type="email"/></FRow>
            <FRow label="Ülke"><FText value={nationality} onChange={setNationality} placeholder="Avustralya"/></FRow>
          </FGrid>
        )}
        {step===1 && (
          <FGrid>
            <FRow label="Tur Kataloğundan Seç">
              <select value={tourId} onChange={e=>pickTour(e.target.value)} style={{ width:"100%", padding:"9px 10px", borderRadius:7, border:`1.5px solid ${C.border}`, fontSize:13.5, color:C.text, background:C.white }}>
                <option value="">-- Tur seçin --</option>
                {tours.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </FRow>
            <FRow label="Tur / Deneyim Adı" required error={errs.tourName}>
              <FText value={tourName} onChange={setTourName} placeholder="Private Istanbul Experience"/>
            </FRow>
          </FGrid>
        )}
        {step===2 && (
          <FGrid>
            <FRow label="Seyahat Tarihi" required error={errs.travelDate}><FText type="date" value={travelDate} onChange={setTravelDate}/></FRow>
            <FRow label="Kişi Sayısı"><FText type="number" value={guestCount} onChange={setGuestCount} placeholder="2"/></FRow>
          </FGrid>
        )}
        {step===3 && (
          <>
            <FGrid>
              <FRow label="Para Birimi"><FSelect value={currency} onChange={setCurrency} options={CURRENCY_OPTIONS}/></FRow>
              <FRow label="Kişi Başı Fiyat" required error={errs.pricePerPerson}><FText type="number" value={pricePerPerson} onChange={setPricePerPerson} placeholder="90"/></FRow>
              <FRow label="İndirim (%)"><FText type="number" value={discountPct} onChange={setDiscountPct} placeholder="0"/></FRow>
              <FRow label="Kapora (%)"><FText type="number" value={depositPct} onChange={setDepositPct} placeholder="25"/></FRow>
            </FGrid>
            <div style={{ marginTop:16, padding:"14px 16px", background:C.goldPale, borderRadius:12, display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
              <span style={{ fontSize:12.5, color:"#8A6D1F", fontFamily:"'DM Sans',sans-serif" }}>Toplam Tutar</span>
              <span style={{ fontSize:19, fontWeight:700, color:"#8A6D1F", fontFamily:"'Playfair Display',serif" }}>{sym}{total.toLocaleString("tr-TR")}</span>
            </div>
            <div style={{ marginTop:18 }}>
              <MobileSection title="Dahil Hizmetler" tight>
                {included.map((it,i)=>(
                  <label key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 2px", cursor:"pointer" }}>
                    <input type="checkbox" checked={it.on} onChange={()=>toggleItem(included,setIncluded,i)}/>
                    <span style={{ fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{it.label}</span>
                  </label>
                ))}
              </MobileSection>
            </div>
            <div style={{ marginTop:14 }}>
              <MobileSection title="Dahil Olmayan Hizmetler" tight>
                {excluded.map((it,i)=>(
                  <label key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 2px", cursor:"pointer" }}>
                    <input type="checkbox" checked={it.on} onChange={()=>toggleItem(excluded,setExcluded,i)}/>
                    <span style={{ fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{it.label}</span>
                  </label>
                ))}
              </MobileSection>
            </div>
          </>
        )}
        {step===4 && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <MobileEntityCard>
              <div style={{ fontSize:16, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>{guestName || "—"}</div>
              <div style={{ fontSize:12.5, color:C.textMuted, fontFamily:"'DM Sans',sans-serif", marginTop:3 }}>
                {[phone, email].filter(Boolean).join(" · ") || "İletişim bilgisi girilmedi"}
              </div>
            </MobileEntityCard>
            <MobileEntityCard>
              <MobileInfoLine label="Tur" value={tourName || "—"}/>
              <MobileInfoLine label="Tarih" value={travelDate || "—"}/>
              <MobileInfoLine label="Kişi Sayısı" value={`${pax} kişi`}/>
            </MobileEntityCard>
            <MobileEntityCard>
              <MobileInfoLine label="Kişi Başı" value={`${sym}${unit.toLocaleString("tr-TR")}`}/>
              <MobileInfoLine label="Toplam" value={`${sym}${total.toLocaleString("tr-TR")}`} bold/>
              <MobileInfoLine label="Kapora" value={`${sym}${deposit.toLocaleString("tr-TR")}`}/>
              <MobileInfoLine label="Kalan" value={`${sym}${remaining.toLocaleString("tr-TR")}`}/>
            </MobileEntityCard>
            <FRow label="Notlar"><FTextArea value={notes} onChange={setNotes} placeholder="Özel talepler…"/></FRow>
          </div>
        )}
      </div>

      {}
      <div style={{ flexShrink:0, background:C.white, borderTop:`1px solid ${C.border}`, padding:`12px 16px calc(12px + env(safe-area-inset-bottom, 0px))` }}>
        <button onClick={goNext} disabled={saving} style={{
          width:"100%", padding:"13px 0", borderRadius:12, border:"none", cursor: saving?"default":"pointer",
          background:C.navy, color:C.white, fontSize:14.5, fontWeight:700, fontFamily:"'DM Sans',sans-serif",
          opacity: saving?0.7:1,
        }}>{saving ? "Kaydediliyor…" : step===STEPS.length-1 ? "Teklifi Kaydet" : "Devam Et"}</button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE MESSAGES — a real messaging inbox/thread, not the desktop
   three-pane split. List and thread are two distinct full screens (never
   both visible together); the thread reuses the desktop's own MsgBubble/
   ChannelBadge components (already sender-separated bubbles) inside a
   dedicated mobile shell with a sticky composer.
   ══════════════════════════════════════════════════════════════════════ */
function MobileMessagesPage() {
  const [view, setView] = useState("list");
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState("Tümü");
  const [draft, setDraft] = useState("");
  const [, forceTick] = useState(0);

  const FILTERS = ["Tümü","Okunmamış","WhatsApp","E-posta"];
  const filtered = MOCK_CONVERSATIONS.filter(c=>{
    if (filter==="Tümü") return true;
    if (filter==="Okunmamış") return c.unread>0;
    return MSG_CHANNELS[c.channel]?.label === filter;
  });
  const totalUnread = MOCK_CONVERSATIONS.reduce((s,c)=>s+c.unread,0);
  const selected = MOCK_CONVERSATIONS.find(c=>c.id===selectedId);

  function open(id) {
    const c = MOCK_CONVERSATIONS.find(x=>x.id===id);
    if (c) c.unread = 0;
    setSelectedId(id);
    setView("detail");
  }
  function send() {
    if (!draft.trim() || !selected) return;
    selected.messages.push({
      id:"m"+Date.now(), dir:"out", text:draft.trim(),
      time:new Date().toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit"}), date:"Bugün",
    });
    selected.lastMessage = draft.trim();
    setDraft("");
    forceTick(t=>t+1);
  }

  if (view==="detail" && selected) {
    const cust = getCustomerById(selected.customerId);
    return (
      <div style={{ position:"fixed", inset:0, zIndex:900, background:C.ivory, display:"flex", flexDirection:"column" }}>
        <div style={{
          flexShrink:0, background:C.white, borderBottom:`1px solid ${C.border}`,
          paddingTop:"env(safe-area-inset-top, 0px)",
          display:"flex", alignItems:"center", gap:10, padding:"calc(10px + env(safe-area-inset-top, 0px)) 12px 10px",
        }}>
          <button onClick={()=>setView("list")} style={{ border:"none", background:"transparent", cursor:"pointer", padding:6, color:C.navy, flexShrink:0 }}>
            <GIc d="M15 18l-6-6 6-6" size={18} sw={2.3}/>
          </button>
          <div style={{ width:36, height:36, borderRadius:"50%", flexShrink:0, background:"rgba(27,45,79,0.09)", display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ fontSize:12, fontWeight:700, color:C.navy, fontFamily:"'DM Sans',sans-serif" }}>{cust?.name?.split(" ").map(w=>w[0]).join("").slice(0,2)||"?"}</span>
          </div>
          <div style={{ minWidth:0, flex:1 }}>
            <div style={{ fontSize:14.5, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{cust?.name || "Bilinmiyor"}</div>
            <ChannelBadge channel={selected.channel} small/>
          </div>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"16px 14px" }}>
          {selected.messages.length>0 && (
            <div style={{ textAlign:"center", marginBottom:14, fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif" }}>
              <span style={{ background:C.ivoryDark, padding:"3px 12px", borderRadius:99, border:`1px solid ${C.border}` }}>{selected.messages[0].date}</span>
            </div>
          )}
          {selected.messages.map(m=><MsgBubble key={m.id} msg={m} customerName={cust?.name}/>)}
        </div>

        <div style={{
          flexShrink:0, background:C.white, borderTop:`1px solid ${C.border}`,
          padding:`10px 12px calc(10px + env(safe-area-inset-bottom, 0px))`,
          display:"flex", gap:8, alignItems:"flex-end",
        }}>
          <textarea value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Mesaj yazın…" rows={1}
            style={{ flex:1, resize:"none", padding:"10px 14px", borderRadius:20, border:`1px solid ${C.border}`, fontSize:14, fontFamily:"'DM Sans',sans-serif", outline:"none", maxHeight:90 }}/>
          <button onClick={send} disabled={!draft.trim()} style={{
            width:40, height:40, borderRadius:"50%", flexShrink:0, border:"none",
            cursor: draft.trim() ? "pointer" : "default",
            background: draft.trim() ? C.navy : C.borderLight,
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <GIc d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" size={16} sw={1.8} color="#fff"/>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div>
        <div style={{ fontSize:20, fontWeight:700, color:C.text, fontFamily:"'Playfair Display',serif" }}>Mesajlar</div>
        {totalUnread>0 && <div style={{ fontSize:12, color:C.red, fontFamily:"'DM Sans',sans-serif", marginTop:2 }}>{totalUnread} okunmamış mesaj</div>}
      </div>

      <div className="rsp-scroll-x" style={{ display:"flex", gap:8 }}>
        {FILTERS.map(f=>(
          <button key={f} onClick={()=>setFilter(f)} style={{
            flexShrink:0, padding:"7px 14px", borderRadius:99, cursor:"pointer",
            border: filter===f ? "none" : `1px solid ${C.border}`,
            background: filter===f ? C.navy : C.white,
            color: filter===f ? C.white : C.textMid,
            fontSize:12.5, fontWeight:500, fontFamily:"'DM Sans',sans-serif",
          }}>{f}</button>
        ))}
      </div>

      {filtered.length===0 ? (
        <MobileEmptyNote text="Konuşma bulunamadı."/>
      ) : (
        <MobileEntityCard style={{ padding:0, overflow:"hidden" }}>
          {filtered.map((c,i)=>{
            const cust = getCustomerById(c.customerId);
            return (
              <div key={c.id} onClick={()=>open(c.id)} style={{
                display:"flex", alignItems:"flex-start", gap:10, padding:"13px 14px", cursor:"pointer",
                borderBottom: i<filtered.length-1 ? `1px solid ${C.borderLight}` : "none",
              }}>
                <div style={{ position:"relative", flexShrink:0 }}>
                  <div style={{ width:40, height:40, borderRadius:"50%", background:"rgba(27,45,79,0.08)", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <span style={{ fontSize:13, fontWeight:700, color:C.navy, fontFamily:"'DM Sans',sans-serif" }}>{cust?.name?.split(" ").map(w=>w[0]).join("").slice(0,2)||"?"}</span>
                  </div>
                  <div style={{ position:"absolute", bottom:-2, right:-2, width:14, height:14, borderRadius:"50%", background:MSG_CHANNELS[c.channel]?.color||C.textFaint, border:`1.5px solid ${C.white}` }}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
                    <span style={{ fontSize:13.5, fontWeight: c.unread>0?700:500, color:C.text, fontFamily:"'DM Sans',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{cust?.name||"Bilinmiyor"}</span>
                    <span style={{ fontSize:11, color:C.textFaint, fontFamily:"'DM Sans',sans-serif", flexShrink:0 }}>{c.lastTime}</span>
                  </div>
                  <div style={{ fontSize:12.5, color: c.unread>0?C.textMid:C.textFaint, fontFamily:"'DM Sans',sans-serif", marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontWeight: c.unread>0?500:400 }}>{c.lastMessage}</div>
                </div>
                {c.unread>0 && (
                  <div style={{ minWidth:18, height:18, borderRadius:99, padding:"0 5px", background:C.red, color:"#fff", fontSize:10, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:2 }}>{c.unread}</div>
                )}
              </div>
            );
          })}
        </MobileEntityCard>
      )}
    </div>
  );
}

function Toast({ msg, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <div style={{
      position:'fixed', bottom:24, left:'50%', transform:'translateX(-50%)',
      background:C.navyDeep, color:C.ivory, padding:'11px 22px', borderRadius:10,
      fontSize:13.5, fontFamily:"'DM Sans',sans-serif", fontWeight:500,
      boxShadow:'0 8px 32px rgba(13,27,62,0.4)', zIndex:9999,
      maxWidth:'90vw', textAlign:'center', pointerEvents:'none',
      animation:'fadeInUp .2s ease',
    }}>{msg}</div>
  );
}

function NotFoundCard({ entityType, entityId, onBack }) {
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'60px 24px',gap:16,textAlign:'center'}}>
      <div style={{fontSize:36}}>🔍</div>
      <div style={{fontSize:18,fontWeight:600,color:C.text,fontFamily:"'Playfair Display',serif"}}>Kayıt bulunamadı</div>
      <div style={{fontSize:13,color:C.textMuted}}>{entityType} kaydı mevcut değil{entityId ? `: ${entityId}` : '.'}</div>
      {onBack && <button onClick={onBack} style={{padding:'9px 20px',borderRadius:8,border:'none',background:C.navy,color:C.white,cursor:'pointer',fontSize:13}}>Geri Dön</button>}
    </div>
  );
}

function SideGroup({ title, items }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{marginBottom:16}}>
      {title && <div style={{fontSize:10.5,textTransform:'uppercase',letterSpacing:'0.1em',color:C.textFaint,fontWeight:600,marginBottom:8,fontFamily:"'DM Sans',sans-serif"}}>{title}</div>}
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        {items.map((item,i) => (
          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:12.5,color:C.text,padding:'5px 0',borderBottom:`1px solid ${C.border}`}}>
            <span style={{color:C.textMuted}}>{item.label}</span>
            <span style={{fontWeight:500}}>{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SideSection({ title, children }) {
  return (
    <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:'14px 16px',marginBottom:12}}>
      {title && <div style={{fontSize:12,fontWeight:600,color:C.text,marginBottom:10,fontFamily:"'DM Sans',sans-serif"}}>{title}</div>}
      {children}
    </div>
  );
}

function TInput({ value, onChange, placeholder, type }) {
  return (
    <input type={type||'text'} value={value||''} onChange={e=>onChange(e.target.value)}
      placeholder={placeholder}
      style={{width:'100%',boxSizing:'border-box',padding:'8px 10px',borderRadius:6,border:`1.5px solid ${C.border}`,fontSize:13.5,color:C.text,fontFamily:"'DM Sans',sans-serif",outline:'none'}}
      onFocus={e=>e.target.style.borderColor=C.navy}
      onBlur={e=>e.target.style.borderColor=C.border}
    />
  );
}

function TSelect({ value, onChange, options }) {
  return (
    <select value={value||''} onChange={e=>onChange(e.target.value)}
      style={{width:'100%',boxSizing:'border-box',padding:'8px 10px',borderRadius:6,border:`1.5px solid ${C.border}`,fontSize:13.5,color:C.text,fontFamily:"'DM Sans',sans-serif",outline:'none',background:C.white}}>
      {(options||[]).map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Field({ label, children }) {
  return (
    <div style={{marginBottom:12}}>
      <label style={{display:'block',fontSize:12,fontWeight:500,color:C.textMid,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>{label}</label>
      {children}
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError:false, error:null }; }
  static getDerivedStateFromError(error) { return { hasError:true, error }; }
  componentDidCatch(error, info) {
    console.error('[DeseTour] Render crash:', error.message, info?.componentStack?.slice(0,300));
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    var err = this.state.error;
    var self = this;
    return React.createElement('div', {
      style:{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',
        background:'linear-gradient(135deg,#0F1D35 0%,#1B2D4F 100%)',padding:24,fontFamily:"'DM Sans',sans-serif"}},
      React.createElement('div', {
        style:{background:'#fff',borderRadius:16,padding:'40px 36px',maxWidth:440,width:'100%',
          textAlign:'center',boxShadow:'0 24px 80px rgba(0,0,0,0.4)'}},
        React.createElement('div', {style:{fontSize:36,marginBottom:16}}, '⚠️'),
        React.createElement('div', {style:{fontSize:20,fontWeight:700,color:'#1B2D4F',
          fontFamily:"'Playfair Display',serif",marginBottom:10}}, 'Bir hata oluştu'),
        React.createElement('div', {style:{fontSize:13.5,color:'#6B7280',lineHeight:1.6,marginBottom:16}},
          'Sayfa yüklenirken beklenmeyen bir sorun oluştu.'),
        err && React.createElement('div', {style:{fontSize:11,color:'#9CA3AF',background:'#F9FAFB',
          borderRadius:6,padding:'8px 12px',marginBottom:20,fontFamily:'monospace',
          textAlign:'left',wordBreak:'break-all'}}, err.message || String(err)),
        React.createElement('div', {style:{display:'flex',gap:10,justifyContent:'center'}},
          React.createElement('button', {
            onClick: function() { window.location.hash='#/dashboard'; self.setState({hasError:false,error:null}); },
            style:{padding:'10px 20px',borderRadius:8,border:'none',background:'#1B2D4F',
              color:'#fff',cursor:'pointer',fontSize:13.5,fontWeight:600}
          }, 'Ana Sayfaya Dön'),
          React.createElement('button', {
            onClick: function() { window.location.reload(); },
            style:{padding:'10px 20px',borderRadius:8,border:'1px solid #E5E7EB',
              background:'#fff',color:'#374151',cursor:'pointer',fontSize:13.5}
          }, 'Sayfayı Yenile')
        )
      )
    );
  }
}

(function mountApp() {
  var container = document.getElementById('root');
  if (!container) { console.error('[DeseTour] #root element not found'); return; }
  var root = ReactDOM.createRoot(container);
  root.render(
    React.createElement(ErrorBoundary, null, React.createElement(App))
  );
})();
