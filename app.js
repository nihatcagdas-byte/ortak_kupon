import { db, authReady, USERS } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, increment,
  collection, query, where, orderBy, onSnapshot, getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================================================
   STATE
   ============================================================ */
const ADMIN_USER = "Nihat";
function isAdmin() { return currentUser === ADMIN_USER; }

let currentUser = localStorage.getItem("kupon_user") || null;
let activeCouponId = null;
let couponsCache = [];
let unsubCouponList = null;
let unsubCouponDetail = null;
let unsubPool = null;
let unsubPayments = null;
let paymentsCache = [];
let modalTargetUser = null;
let poolBalance = 0;
const poolRef = doc(db, "meta", "pool");
let chartPeriod = "week";
let chartMetric = "entered";
let barChartInstance = null;
let lineChartInstance = null;
const USER_COLORS = { Nihat: "#D9A62E", Mahir: "#3B6EA5", Cenk: "#B84A3E", Ebuzer: "#3F8F5C" };
const METRIC_LABELS = {
  entered: "Girilen Maç", won: "Kazanılan Maç", hitrate: "İsabet Oranı (%)",
  amount: "Toplam Yatırım (₺)", oddsproduct: "Oran Toplamı"
};

const pinState = { mode: "login", stage: "first", first: "", current: "", targetName: null, busy: false };

/* ============================================================
   HELPERS
   ============================================================ */
function pad(n) { return String(n).padStart(2, "0"); }
function dateKeyFor(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function displayDateFor(d) { return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
function parseDateKey(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function startOfWeek(d) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Pazartesi başlangıçlı hafta
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}
function endOfWeek(d) {
  const s = startOfWeek(d);
  const e = new Date(s);
  e.setDate(s.getDate() + 6);
  e.setHours(23, 59, 59, 999);
  return e;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); }
const TR_MONTHS = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}
function switchView(name) {
  document.querySelectorAll(".app-shell .view").forEach(v => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
}

/* ============================================================
   LOGIN FLOW
   ============================================================ */
function renderNameGrid() {
  const grid = document.getElementById("name-select");
  grid.innerHTML = "";
  USERS.forEach((name, i) => {
    const btn = document.createElement("button");
    btn.className = "name-card";
    btn.innerHTML = `<span class="jersey-num">#${i + 1}</span>${name}`;
    btn.addEventListener("click", () => startPinFlow(name));
    grid.appendChild(btn);
  });
}

async function startPinFlow(name) {
  pinState.targetName = name;
  pinState.first = "";
  pinState.current = "";
  pinState.stage = "first";
  pinState.busy = false;

  document.getElementById("name-select").classList.add("hidden");
  document.getElementById("pin-pad").classList.remove("hidden");
  document.getElementById("pin-name").textContent = name;
  document.getElementById("pin-error").classList.add("hidden");
  document.getElementById("pin-sub").textContent = "Kontrol ediliyor…";
  renderPinDots();

  try {
    const snap = await getDoc(doc(db, "users", name));
    if (snap.exists() && snap.data().pinSet) {
      pinState.mode = "login";
      document.getElementById("pin-sub").textContent = "4 haneli şifreni gir";
    } else {
      pinState.mode = "create";
      document.getElementById("pin-sub").textContent = "İlk giriş: 4 haneli bir şifre oluştur";
    }
  } catch (err) {
    console.error("Kullanıcı bilgisi okunamadı:", err);
    pinState.mode = "login";
    document.getElementById("pin-sub").textContent = "4 haneli şifreni gir";
    showPinError("Bağlantı sorunu olabilir. Şifreni girip 'Giriş Yap'a bas.");
  }
  renderPinDots();
}

function showPinError(msg) {
  const errEl = document.getElementById("pin-error");
  errEl.textContent = msg;
  errEl.classList.remove("hidden");
}

function setPinBusy(busy) {
  pinState.busy = busy;
  const btn = document.getElementById("pin-submit");
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? "Kontrol ediliyor…" : (pinState.mode === "create" && pinState.stage === "confirm" ? "Onayla" : (pinState.mode === "create" ? "Devam Et" : "Giriş Yap"));
}

function renderPinDots() {
  const dots = document.querySelectorAll(".pin-dot");
  dots.forEach((d, i) => d.classList.toggle("filled", i < pinState.current.length));
  const btn = document.getElementById("pin-submit");
  if (btn && !pinState.busy) {
    btn.disabled = pinState.current.length !== 4;
    btn.textContent = pinState.mode === "create"
      ? (pinState.stage === "confirm" ? "Onayla" : "Devam Et")
      : "Giriş Yap";
  }
}

function handlePinDigit(digit) {
  if (pinState.busy) return;
  if (pinState.current.length >= 4) return;
  pinState.current += digit;
  renderPinDots();
  if (pinState.current.length === 4) {
    setTimeout(() => { if (!pinState.busy) processPinComplete(); }, 180);
  }
}

function handlePinDelete() {
  if (pinState.busy) return;
  pinState.current = pinState.current.slice(0, -1);
  document.getElementById("pin-error").classList.add("hidden");
  renderPinDots();
}

async function processPinComplete() {
  if (pinState.busy) return;
  if (pinState.current.length !== 4) {
    showPinError("4 hane girmelisin.");
    return;
  }
  const errEl = document.getElementById("pin-error");
  errEl.classList.add("hidden");

  if (pinState.mode === "login") {
    setPinBusy(true);
    try {
      const snap = await getDoc(doc(db, "users", pinState.targetName));
      const realPin = snap.exists() ? snap.data().pin : null;
      if (realPin === null) {
        // Kayıt yokmuş — şifre oluşturma akışına geç
        pinState.mode = "create";
        pinState.stage = "first";
        pinState.first = "";
        pinState.current = "";
        document.getElementById("pin-sub").textContent = "İlk giriş: 4 haneli bir şifre oluştur";
        setPinBusy(false);
        renderPinDots();
        return;
      }
      if (pinState.current === realPin) {
        loginAs(pinState.targetName);
        return;
      }
      showPinError("Şifre yanlış, tekrar dene.");
      pinState.current = "";
    } catch (err) {
      console.error("Giriş kontrolü başarısız:", err);
      showPinError("Bağlanılamadı: " + (err.code || err.message || "bilinmeyen hata"));
      pinState.current = "";
    }
    setPinBusy(false);
    renderPinDots();
    return;
  }

  // mode === create
  if (pinState.stage === "first") {
    pinState.first = pinState.current;
    pinState.current = "";
    pinState.stage = "confirm";
    document.getElementById("pin-sub").textContent = "Şifreni onayla";
    renderPinDots();
    return;
  }

  // stage === confirm
  if (pinState.current === pinState.first) {
    setPinBusy(true);
    try {
      await setDoc(doc(db, "users", pinState.targetName), { pin: pinState.first, pinSet: true });
      loginAs(pinState.targetName);
      return;
    } catch (err) {
      console.error("Şifre kaydedilemedi:", err);
      showPinError("Kaydedilemedi: " + (err.code || err.message || "bilinmeyen hata"));
      setPinBusy(false);
    }
  } else {
    showPinError("Şifreler eşleşmedi, baştan dene.");
    pinState.stage = "first";
    pinState.first = "";
    pinState.current = "";
    document.getElementById("pin-sub").textContent = "4 haneli bir şifre oluştur";
  }
  renderPinDots();
}

function loginAs(name) {
  currentUser = name;
  localStorage.setItem("kupon_user", name);
  enterApp();
}

function logout() {
  currentUser = null;
  localStorage.removeItem("kupon_user");
  if (unsubCouponList) unsubCouponList();
  if (unsubCouponDetail) unsubCouponDetail();
  if (unsubPool) unsubPool();
  if (unsubMatches) unsubMatches();
  if (unsubPayments) unsubPayments();
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("view-login").classList.add("active");
  document.getElementById("pin-pad").classList.add("hidden");
  document.getElementById("name-select").classList.remove("hidden");
  pinState.current = ""; pinState.first = "";
  renderNameGrid();
}

/* ============================================================
   APP ENTRY
   ============================================================ */
function enterApp() {
  document.getElementById("view-login").classList.remove("active");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("current-user-tag").textContent = currentUser;
  switchView("home");
  subscribeCouponList();
  subscribePool();
  subscribePayments();
  subscribeMatches();
}

/* ============================================================
   ORTAK KASA (HAVUZ)
   ============================================================ */
function subscribePool() {
  if (unsubPool) unsubPool();
  unsubPool = onSnapshot(poolRef, async (snap) => {
    if (!snap.exists()) {
      try { await setDoc(poolRef, { balance: 0 }); } catch (e) { console.error(e); }
      return;
    }
    poolBalance = Number(snap.data().balance || 0);
    renderPoolCard();
    renderDebtAndShare();
    // Kupon detayındaysak, havuz bakiyesine bağlı butonları (etiketler vb.) tazele
    const cc = couponsCache.find(x => x.id === activeCouponId);
    if (cc && document.getElementById("view-coupon").classList.contains("active")) {
      renderCouponDetail(cc);
    }
  });
}

function renderPoolCard() {
  const el = document.getElementById("pool-card");
  if (!el) return;
  el.innerHTML = `
    <span class="pool-icon">🏦</span>
    <div>
      <div class="pool-label">Ortak Kasa</div>
      <div class="pool-value">${poolBalance.toFixed(0)}₺</div>
    </div>
    ${isAdmin() ? `<button id="pool-edit-btn" class="pool-edit-btn" title="Manuel düzelt">✎</button>` : ""}
  `;
  const editBtn = document.getElementById("pool-edit-btn");
  if (editBtn) editBtn.addEventListener("click", adjustPoolManually);
}

async function adjustPoolManually() {
  const input = window.prompt("Havuza eklenecek/çıkarılacak tutarı gir (çıkarmak için başına - koy). Örn: 200 veya -50");
  if (input === null) return;
  const value = parseFloat(input.replace(",", "."));
  if (isNaN(value) || value === 0) return;
  try {
    await updateDoc(poolRef, { balance: increment(value) });
    showToast(`Havuz güncellendi (${value > 0 ? "+" : ""}${value}₺)`);
  } catch (err) {
    console.error(err);
    showToast("Havuz güncellenemedi: " + (err.code || err.message));
  }
}

/* ============================================================
   MAÇLAR (API-Football'dan günde 2 kez çekilen veri)
   ============================================================ */
let unsubMatches = null;
const standingsCache = {};

async function preloadStandings(data) {
  if (!data || !data.matches) return;
  const leagueIds = [...new Set(data.matches.map(m => m.leagueId))].filter(id => !(id in standingsCache));
  await Promise.all(leagueIds.map(async id => {
    try {
      const snap = await getDoc(doc(db, "standings", String(id)));
      standingsCache[id] = snap.exists() ? (snap.data().table || []) : [];
    } catch (err) {
      console.error(`Puan durumu okunamadı (lig ${id}):`, err);
      standingsCache[id] = [];
    }
  }));
}
let matchesDay = "today";

function subscribeMatches() {
  if (unsubMatches) unsubMatches();
  const base = new Date();
  if (matchesDay === "tomorrow") base.setDate(base.getDate() + 1);
  const dateKey = dateKeyFor(base);
  unsubMatches = onSnapshot(doc(db, "liveMatches", dateKey), async (snap) => {
    if (!snap.exists()) {
      renderMatches(null);
      return;
    }
    const data = snap.data();
    await preloadStandings(data);
    renderMatches(data);
  }, (err) => {
    console.error("Maç verisi okunamadı:", err);
    renderMatches(null);
  });
}

function matchStatusLabel(m) {
  const live = ["1H", "2H", "HT", "ET", "P", "LIVE"];
  const finished = ["FT", "AET", "PEN"];
  if (live.includes(m.status)) return { text: m.elapsed ? `${m.elapsed}'` : "CANLI", live: true };
  if (finished.includes(m.status)) return { text: "MS", live: false };
  // Henüz oynanmadı — saat göster
  const d = new Date(m.date);
  return { text: `${pad(d.getHours())}:${pad(d.getMinutes())}`, live: false };
}

function renderMatches(data) {
  const listEl = document.getElementById("matches-list");
  const updatedEl = document.getElementById("matches-updated");
  if (!listEl) return;

  if (!data || !data.matches || data.matches.length === 0) {
    updatedEl.textContent = data && data.updatedAt ? `Son güncelleme: ${formatTimestamp(data.updatedAt)}` : "Henüz veri yok";
    const when = matchesDay === "tomorrow" ? "yarın (veri saat 12:00'de çekilir)" : "bugün (veri saat 09:00'da çekilir)";
    listEl.innerHTML = `<div class="matches-empty">Takip edilen liglerde ${when} maç görünmüyor ya da veri henüz çekilmedi.</div>`;
    return;
  }

  updatedEl.textContent = `Son güncelleme: ${formatTimestamp(data.updatedAt)}`;

  const byLeague = {};
  data.matches.forEach(m => {
    if (!byLeague[m.league]) byLeague[m.league] = [];
    byLeague[m.league].push(m);
  });

  listEl.innerHTML = "";
  Object.keys(byLeague).forEach(league => {
    const group = document.createElement("div");
    group.className = "league-group";
    group.innerHTML = `<div class="league-group-title">${escapeHtml(league)}</div>`;
    byLeague[league].forEach(m => {
      const st = matchStatusLabel(m);
      const hasScore = m.goalsHome !== null && m.goalsHome !== undefined;
      const wrap = document.createElement("div");
      wrap.className = "match-card-wrap";
      wrap.innerHTML = `
        <div class="match-card">
          <span class="match-time ${st.live ? "match-live" : ""}">${st.text}</span>
          <span class="match-teams">${escapeHtml(m.home)} — ${escapeHtml(m.away)}</span>
          ${hasScore ? `<span class="match-score">${m.goalsHome} - ${m.goalsAway}</span>` : ""}
          ${m.odds ? `
            <span class="match-odds">
              <span class="match-odds-chip">${m.odds.home || "-"}<span>1</span></span>
              <span class="match-odds-chip">${m.odds.draw || "-"}<span>X</span></span>
              <span class="match-odds-chip">${m.odds.away || "-"}<span>2</span></span>
            </span>
          ` : ""}
          ${m.stats ? `<button class="match-detail-toggle" data-target="stats-${m.fixtureId}">İstatistik ▾</button>` : ""}
        </div>
        ${m.stats ? buildStatsPanel(m) : ""}
      `;
      group.appendChild(wrap);
    });
    listEl.appendChild(group);
  });

  listEl.querySelectorAll(".match-detail-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById(btn.dataset.target);
      if (!panel) return;
      const nowHidden = panel.classList.toggle("hidden");
      btn.textContent = nowHidden ? "İstatistik ▾" : "İstatistik ▴";
    });
  });
}

function formChips(formStr) {
  if (!formStr) return `<span class="form-empty">—</span>`;
  return formStr.slice(-5).split("").map(c => {
    const cls = c === "W" ? "form-w" : c === "D" ? "form-d" : c === "L" ? "form-l" : "form-empty";
    return `<span class="form-chip ${cls}">${c}</span>`;
  }).join("");
}

function combinedGoalsChip(goalsAvg) {
  const home = parseFloat(goalsAvg.homeFor);
  const away = parseFloat(goalsAvg.awayFor);
  if (isNaN(home) || isNaN(away)) return "";
  const total = (home + away).toFixed(2);
  return `<span class="predict-chip">Olası toplam gol*: ${total}</span>`;
}

function tip(text) {
  return `<span class="stat-info" data-tooltip="${text}">ⓘ</span>`;
}

const COMPARE_LABELS = {
  form: ["Form", "Son maçlardaki genel performansa göre karşılaştırma."],
  att: ["Hücum Gücü", "İki takımın hücum gücünün yüzdesel karşılaştırması (attığı gol, isabetli şut gibi verilere dayanır)."],
  def: ["Savunma Gücü", "İki takımın savunma gücünün yüzdesel karşılaştırması (yediği gol, önlenen şut gibi verilere dayanır)."],
  poisson: ["Poisson Dağılımı", "İstatistiksel gol dağılım modeline göre kazanma ihtimali karşılaştırması."],
  goals: ["Gol Verimi", "Attılan/yenilen gol verimliliğine göre karşılaştırma."],
  total: ["Genel", "Form, hücum, savunma, gol ve geçmiş karşılaşmaların ağırlıklı ortalamasına göre genel karşılaştırma."]
};

function compareBar(key, pair) {
  if (!pair || (!pair.home && !pair.away)) return "";
  const [label, tooltip] = COMPARE_LABELS[key];
  const home = parseFloat(pair.home) || 0;
  const away = parseFloat(pair.away) || 0;
  return `
    <div class="compare-row">
      <div class="compare-label">${label}${tip(tooltip)}</div>
      <div class="compare-bar">
        <span class="compare-seg compare-seg-home" style="width:${home}%"></span>
        <span class="compare-seg compare-seg-away" style="width:${away}%"></span>
      </div>
      <div class="compare-values"><span>${pair.home || "-"}</span><span>${pair.away || "-"}</span></div>
    </div>
  `;
}

function restDaysLine(s, m) {
  if (!s.restDays || (s.restDays.home == null && s.restDays.away == null)) return "";
  const h = s.restDays.home != null ? `${s.restDays.home} gün` : "veri yok";
  const a = s.restDays.away != null ? `${s.restDays.away} gün` : "veri yok";
  return `
    <div class="stats-predict">
      <span class="predict-chip">🛌 ${escapeHtml(m.home)}: ${h} dinlenmiş${tip("Takımın bir önceki maçından bu yana geçen gün sayısı. Sitemizin kendi geçmiş kayıtlarından hesaplanır (API'den değil) — ilk günlerde yeterli geçmiş birikmediyse boş çıkabilir.")}</span>
      <span class="predict-chip">🛌 ${escapeHtml(m.away)}: ${a} dinlenmiş</span>
    </div>
  `;
}

function injuriesBlock(s) {
  const home = (s.injuries && s.injuries.home) || [];
  const away = (s.injuries && s.injuries.away) || [];
  if (home.length === 0 && away.length === 0) return "";
  const renderList = (list) => list.length
    ? list.map(p => `<div class="injury-row">🚑 ${escapeHtml(p.player || "?")} <span class="injury-reason">${escapeHtml(p.reason || "")}</span></div>`).join("")
    : `<p class="stats-empty">Bilinen eksik yok.</p>`;
  return `
    <div class="stats-col-title compare-title">Sakatlık / Ceza${tip("API-Football'dan çekilen, maç günü itibarıyla kadro dışı olduğu bilinen oyuncular. Liste her ligde eksiksiz olmayabilir.")}</div>
    <div class="stats-grid">
      <div class="stats-col">${renderList(home)}</div>
      <div class="stats-col">${renderList(away)}</div>
    </div>
  `;
}

function standingsBlock(m) {
  const table = standingsCache[m.leagueId];
  if (!table || table.length === 0) return "";
  const homeRow = table.find(r => r.teamId === m.homeId);
  const awayRow = table.find(r => r.teamId === m.awayId);
  if (!homeRow && !awayRow) return "";
  const rowHtml = (r) => r
    ? `${r.rank}. sıra · ${r.points} puan · ${r.win}G ${r.draw}B ${r.lose}M`
    : "—";
  return `
    <div class="stats-col-title compare-title">Puan Durumu${tip("Ligdeki güncel sıralama. API kotasını korumak için haftada bir kez, Salı sabahı güncellenir — anlık değildir.")}</div>
    <div class="stats-line"><span>${escapeHtml(m.home)}</span><span>${rowHtml(homeRow)}</span></div>
    <div class="stats-line"><span>${escapeHtml(m.away)}</span><span>${rowHtml(awayRow)}</span></div>
  `;
}

function buildStatsPanel(m) {
  const s = m.stats;
  const h2hRows = (s.h2h || []).map(h => {
    const d = new Date(h.date);
    return `<div class="h2h-row">
      <span class="h2h-date">${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}</span>
      <span class="h2h-teams">${escapeHtml(h.home)} ${h.goalsHome}-${h.goalsAway} ${escapeHtml(h.away)}</span>
    </div>`;
  }).join("") || `<p class="stats-empty">Geçmiş karşılaşma verisi yok.</p>`;

  const compareRows = s.comparison
    ? ["att", "def", "form", "goals", "poisson", "total"].map(k => compareBar(k, s.comparison[k])).join("")
    : "";

  return `
    <div id="stats-${m.fixtureId}" class="match-detail hidden">
      <div class="stats-grid">
        <div class="stats-col">
          <div class="stats-col-title">${escapeHtml(m.home)}</div>
          <div class="stats-line"><span>Form (son 5)${tip("W = Galibiyet, D = Beraberlik, L = Mağlubiyet")}</span><span class="form-chips">${formChips(s.form.home)}</span></div>
          <div class="stats-line"><span>Attığı gol ort.${tip("Sadece iç sahadaki maçlarına göre ortalama.")}</span><span>${s.goalsAvg.homeFor ?? "—"}</span></div>
          <div class="stats-line"><span>Yediği gol ort.${tip("Sadece iç sahadaki maçlarına göre ortalama.")}</span><span>${s.goalsAvg.homeAgainst ?? "—"}</span></div>
        </div>
        <div class="stats-col">
          <div class="stats-col-title">${escapeHtml(m.away)}</div>
          <div class="stats-line"><span>Form (son 5)${tip("W = Galibiyet, D = Beraberlik, L = Mağlubiyet")}</span><span class="form-chips">${formChips(s.form.away)}</span></div>
          <div class="stats-line"><span>Attığı gol ort.${tip("Sadece deplasmandaki maçlarına göre ortalama.")}</span><span>${s.goalsAvg.awayFor ?? "—"}</span></div>
          <div class="stats-line"><span>Yediği gol ort.${tip("Sadece deplasmandaki maçlarına göre ortalama.")}</span><span>${s.goalsAvg.awayAgainst ?? "—"}</span></div>
        </div>
      </div>

      ${compareRows ? `
        <div class="stats-col-title compare-title">Karşılaştırma${tip("API-Football'ın kendi istatistiksel modeli (form, hücum, savunma, gol, geçmiş maçlar). Bahis oranı değildir.")}</div>
        <div class="compare-block">${compareRows}</div>
      ` : ""}

      <div class="stats-predict">
        ${s.winPercent ? `<span class="predict-chip">Ev %${(s.winPercent.home || "-").replace("%", "")} · Berabere %${(s.winPercent.draw || "-").replace("%", "")} · Dep %${(s.winPercent.away || "-").replace("%", "")}${tip("API-Football'ın istatistiksel modeline göre maç sonucu olasılığı. Bahis oranı değildir.")}</span>` : ""}
        ${combinedGoalsChip(s.goalsAvg)}
      </div>
      <p class="stats-disclaimer">* Toplam gol tahmini, iki takımın attığı gol ortalamalarının toplamıdır — kendi hesapladığımız kaba bir gösterge, resmi bahis oranı değildir.</p>
      ${restDaysLine(s, m)}
      ${standingsBlock(m)}
      ${injuriesBlock(s)}
      <div class="stats-h2h">
        <div class="stats-col-title">Son karşılaşmalar</div>
        ${h2hRows}
      </div>
    </div>
  `;
}

function formatTimestamp(ts) {
  if (!ts || !ts.toDate) return "—";
  const d = ts.toDate();
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ============================================================
   COUPON LIST
   ============================================================ */
function subscribeCouponList() {
  if (unsubCouponList) unsubCouponList();
  const q = query(collection(db, "coupons"), orderBy("createdAt", "desc"));
  unsubCouponList = onSnapshot(q, (snap) => {
    couponsCache = [];
    snap.forEach(d => couponsCache.push({ id: d.id, ...d.data() }));
    renderCouponList();
    renderStats();
  });
}

// Bir kuponun "kadrosu" — o kupon oluşturulduğunda kimin slotu açıldıysa
// onlar. Aktif kullanıcı listesi (USERS) sonradan değişse bile (örn. biri
// pasif edilse) geçmiş kuponların gerçek katılımcı sayısı ve sonucu bundan
// etkilenmesin diye, USERS yerine HER ZAMAN kuponun kendi verisini kullanıyoruz.
function couponRoster(c) {
  return c.matches ? Object.keys(c.matches) : USERS;
}

function couponTotals(c) {
  if (isSistem(c)) {
    const h = sistemHesap(c);
    const prod = sistemBacaklar(c).reduce((p, l) => p * l.odds, 1);
    const filledS = couponRoster(c).filter(u => c.matches && c.matches[u]).length;
    return { totalStake: h.stake, totalOdds: prod, payout: h.payout != null ? h.payout : h.maxPayout, payoutReal: h.payout, filled: filledS };
  }
  let totalStake = 0, totalOdds = 1, filled = 0;
  couponRoster(c).forEach(u => {
    const m = c.matches ? c.matches[u] : null;
    if (m) {
      totalStake += Number(m.amount || 0);
      totalOdds *= Number(m.odds || 1);
      filled++;
    }
  });
  const payout = filled > 0 ? totalStake * totalOdds : 0;
  return { totalStake, totalOdds, payout, filled };
}

function couponProgress(c) {
  const roster = couponRoster(c);
  return roster.filter(u => c.matches && c.matches[u]).length;
}
function couponStatusInfo(c) {
  const roster = couponRoster(c);
  const filled = couponProgress(c);
  if (filled < roster.length) return { key: "open", label: "Açık" };
  if (!c.playedBy) return { key: "ready", label: "Hazır" };
  if (isSistem(c)) {
    const h = sistemHesap(c);
    if (!h.tamam) return { key: "played", label: "Oynandı" };
    return h.payout + 0.005 >= h.stake ? { key: "won", label: "Tuttu" } : { key: "lost", label: "Tutmadı" };
  }
  const resultsFilled = roster.filter(u => c.results && c.results[u]).length;
  if (resultsFilled < roster.length) return { key: "played", label: "Oynandı" };
  const won = roster.every(u => c.results[u] === "tuttu");
  return won ? { key: "won", label: "Tuttu" } : { key: "lost", label: "Tutmadı" };
}

function renderCouponList() {
  const list = document.getElementById("coupon-list");
  list.innerHTML = "";
  if (couponsCache.length === 0) {
    list.innerHTML = `<div class="empty-note">Henüz kupon yok. "+ Yeni Kupon" ile ilkini aç.</div>`;
    return;
  }
  couponsCache.forEach(c => {
    const info = couponStatusInfo(c);
    const filled = couponProgress(c);
    const totals = couponTotals(c);
    const row = document.createElement("div");
    row.className = "coupon-row";
    const sis = isSistem(c);
    const sh = sis ? sistemHesap(c) : null;
    row.innerHTML = `
      <div class="coupon-row-left">
        <div>
          <div class="coupon-date">${c.displayName}${sis ? ' <span class="sm-badge">SİSTEM</span>' : ""}</div>
          <div class="coupon-progress">${sis ? `${filled}/${couponRoster(c).length} kişi girdi (${sistemBacaklar(c).length} maç)` : `${filled}/${couponRoster(c).length} maç girildi`}${c.playedBy ? " · Oynatan: " + c.playedBy : ""}</div>
        </div>
      </div>
      ${sis ? (c.playedBy ? `
        <div class="coupon-summary-inline">
          <span class="coupon-summary-chip">${sh.stake.toFixed(0)}₺ · ${sh.ks.join("+")} sistem</span>
          <span class="coupon-summary-chip coupon-summary-chip-win">${sh.payout != null ? "Gelen: " + sh.payout.toFixed(0) : "En çok: " + sh.maxPayout.toFixed(0)}₺</span>
        </div>` : "") : totals.filled > 0 ? `
        <div class="coupon-summary-inline">
          <span class="coupon-summary-chip">${totals.totalStake}₺ yatırıldı</span>
          <span class="coupon-summary-chip coupon-summary-chip-win">Olası kazanç: ${totals.payout.toFixed(0)}₺</span>
        </div>
      ` : ""}
      <span class="status-pill status-${info.key}">${info.label}</span>
    `;
    row.addEventListener("click", () => openCoupon(c.id));
    list.appendChild(row);
  });
}

async function createNewCoupon() {
  const now = new Date();
  const dateKey = dateKeyFor(now);
  const displayDate = displayDateFor(now);
  const q = query(collection(db, "coupons"), where("dateKey", "==", dateKey));
  const snap = await getDocs(q);
  const seq = snap.size + 1;
  const docId = seq === 1 ? dateKey : `${dateKey}-${seq}`;
  const displayName = seq === 1 ? displayDate : `${displayDate} (${seq})`;

  const matches = {}, results = {};
  USERS.forEach(u => { matches[u] = null; results[u] = null; });

  await setDoc(doc(db, "coupons", docId), {
    dateKey, seq, displayName,
    createdAt: serverTimestamp(),
    createdBy: currentUser,
    matches, results,
    playedBy: null, playedAt: null
  });
  showToast(`${displayName} kuponu açıldı`);
  openCoupon(docId);
}

/* ============================================================
   COUPON DETAIL
   ============================================================ */
function openCoupon(id) {
  activeCouponId = id;
  switchView("coupon");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));

  if (unsubCouponDetail) unsubCouponDetail();
  unsubCouponDetail = onSnapshot(doc(db, "coupons", id), (snap) => {
    if (!snap.exists()) return;
    renderCouponDetail({ id: snap.id, ...snap.data() });
  });
}

function renderCouponDetail(c) {
  const titleEl = document.getElementById("coupon-title");
  titleEl.textContent = c.displayName;
  if (isSistem(c)) titleEl.insertAdjacentHTML("beforeend", ' <span class="sm-badge">SİSTEM</span>');
  const info = couponStatusInfo(c);
  const statusEl = document.getElementById("coupon-status");
  statusEl.textContent = info.label;
  statusEl.className = `status-pill status-${info.key}`;

  const adminBar = document.getElementById("admin-bar");
  if (isAdmin()) {
    adminBar.classList.remove("hidden");
    adminBar.innerHTML = `
      <span class="admin-tag">★ Admin</span>
      <button id="delete-coupon-btn" class="btn-danger">🗑 Kuponu Sil</button>
    `;
    document.getElementById("delete-coupon-btn").addEventListener("click", () => deleteCoupon(c.id));
  } else {
    adminBar.classList.add("hidden");
    adminBar.innerHTML = "";
  }

  const slotsEl = document.getElementById("match-slots");
  slotsEl.innerHTML = "";
  couponRoster(c).forEach((user, i) => {
    if (isSistem(c)) { slotsEl.appendChild(sistemSlot(c, user, i)); return; }
    const m = c.matches ? c.matches[user] : null;
    const result = c.results ? c.results[user] : null;
    const isSelf = user === currentUser;
    const notPlayedYet = !c.playedBy;
    const selfCanEdit = isSelf && notPlayedYet;
    const canEditThis = isAdmin() || selfCanEdit;
    const slot = document.createElement("div");

    if (!m) {
      slot.className = `match-slot slot-empty ${isSelf ? "slot-self" : ""}`;
      slot.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <div class="slot-body">
          <div class="slot-player">${user}</div>
          <div class="slot-empty-label">${isSelf ? "Maçını girmek için dokun →" : "Maç bekleniyor…"}</div>
        </div>
        ${isAdmin() && !isSelf ? `<button class="slot-fill-btn" data-user="${user}">Doldur</button>` : ""}
      `;
      if (isSelf) slot.addEventListener("click", () => openMatchModal(user, null, c.id));
      const fillBtn = slot.querySelector(".slot-fill-btn");
      if (fillBtn) fillBtn.addEventListener("click", (e) => { e.stopPropagation(); openMatchModal(user, null, c.id); });
    } else {
      slot.className = "match-slot";
      let resultBadge = "";
      if (result === "tuttu") resultBadge = `<span class="slot-result status-won">Tuttu</span>`;
      else if (result === "tutmadi") resultBadge = `<span class="slot-result status-lost">Tutmadı</span>`;
      slot.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <div class="slot-body">
          <div class="slot-player">${user}</div>
          <div class="slot-teams">${escapeHtml(m.teams)}</div>
          ${m.day && m.time ? `<div class="slot-time">🗓 ${escapeHtml(m.day)} ${escapeHtml(m.time)}</div>` : ""}
          <div class="slot-prediction">${escapeHtml(m.prediction)}</div>
          <div class="slot-amount">${Number(m.amount || 0)}₺ yatırdı</div>
        </div>
        <span class="slot-odds">${Number(m.odds).toFixed(2)}</span>
        ${resultBadge}
        ${canEditThis ? `<button class="slot-edit-btn" data-user="${user}" title="Düzenle">✎</button>` : ""}
      `;
      if (canEditThis) {
        slot.querySelector(".slot-edit-btn").addEventListener("click", () => openMatchModal(user, m, c.id));
      }
    }
    slotsEl.appendChild(slot);
  });

  const summaryEl = document.getElementById("kupon-summary");
  const totals = couponTotals(c);
  if (isSistem(c)) {
    const sh = sistemHesap(c);
    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = c.playedBy ? `
      <div class="kupon-summary-item"><div class="kupon-summary-value">${sh.stake.toFixed(0)}₺</div><div class="kupon-summary-label">Toplam Yatırım</div></div>
      <div class="kupon-summary-item"><div class="kupon-summary-value">${sh.kolon}</div><div class="kupon-summary-label">Kolon (${sh.ks.join("+")})</div></div>
      <div class="kupon-summary-item"><div class="kupon-summary-value">${(sh.payout != null ? sh.payout : sh.maxPayout).toFixed(0)}₺</div><div class="kupon-summary-label">${sh.payout != null ? "Gelen Kazanç" : "En Çok Kazanç"}</div></div>
    ` : `
      <div class="kupon-summary-item"><div class="kupon-summary-value">${sh.n}</div><div class="kupon-summary-label">Maç</div></div>
      <div class="kupon-summary-item"><div class="kupon-summary-value">${totals.totalOdds.toFixed(2)}</div><div class="kupon-summary-label">Tümü Tutarsa Oran</div></div>
    `;
    renderTicketFooter(c, info);
    return;
  }
  if (totals.filled > 0) {
    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = `
      <div class="kupon-summary-item">
        <div class="kupon-summary-value">${totals.totalStake}₺</div>
        <div class="kupon-summary-label">Toplam Yatırım</div>
      </div>
      <div class="kupon-summary-item">
        <div class="kupon-summary-value">${totals.totalOdds.toFixed(2)}</div>
        <div class="kupon-summary-label">Toplam Oran</div>
      </div>
      <div class="kupon-summary-item">
        <div class="kupon-summary-value">${totals.payout.toFixed(0)}₺</div>
        <div class="kupon-summary-label">Olası Kazanç${totals.filled < couponRoster(c).length ? " (şimdilik)" : ""}</div>
      </div>
    `;
  } else {
    summaryEl.classList.add("hidden");
    summaryEl.innerHTML = "";
  }

  renderTicketFooter(c, info);
}

function renderTicketFooter(c, info) {
  if (isSistem(c)) { renderSistemFooter(c, info); return; }
  const footer = document.getElementById("ticket-footer");
  footer.innerHTML = "";

  if (info.key === "open") {
    footer.innerHTML = `<p class="footer-note">Herkes kendi maçını girdiğinde kupon hazır olacak.</p>`;
    return;
  }

  if (info.key === "ready") {
    footer.innerHTML = `<p class="footer-note">Tüm maçlar girildi. Kupon parası nereden karşılanacak?</p>`;
    const totals = couponTotals(c);
    const row = document.createElement("div");
    row.className = "fund-choice-row";
    row.innerHTML = `
      <button id="fund-players-btn" class="btn-primary">👥 Kullanıcılardan</button>
      <button id="fund-pool-btn" class="btn-secondary">🏦 Havuzdan <span class="fund-pool-balance">(${poolBalance.toFixed(0)}₺)</span></button>
    `;
    footer.appendChild(row);
    footer.insertAdjacentHTML("beforeend", `<p class="footer-note fund-note">Gerekli tutar: ${totals.totalStake}₺</p>`);
    document.getElementById("fund-players-btn").addEventListener("click", () => markPlayed(c, "players"));
    document.getElementById("fund-pool-btn").addEventListener("click", () => markPlayed(c, "pool"));
    return;
  }

  // played / won / lost — sonuç bölümü
  const canEditResults = isAdmin() || c.playedBy === currentUser;

  if (info.key === "won" || info.key === "lost") {
    const won = info.key === "won";
    const fundLabel = c.fundingSource === "pool" ? "Havuzdan" : "Kullanıcılardan";
    footer.innerHTML = `
      <div class="final-banner ${won ? "won" : "lost"}">${won ? "🏆 Kupon Tuttu" : "Kupon Tutmadı"}</div>
      <p class="play-summary">Oynatan: <strong>${c.playedBy}</strong> · Kaynak: <strong>${fundLabel}</strong></p>
    `;
    if (isAdmin()) footer.appendChild(buildFundEditRow(c));

    if (won) {
      if (c.payoutAction) {
        const label = c.payoutAction === "pooled" ? "Havuza eklendi" : "Kişilere dağıtıldı";
        footer.insertAdjacentHTML("beforeend", `<p class="footer-note payout-done">Kazanç: <strong>${label}</strong></p>`);
      } else if (canEditResults) {
        const totals = couponTotals(c);
        footer.insertAdjacentHTML("beforeend", `<p class="footer-note">Kazanılan <strong>${totals.payout.toFixed(0)}₺</strong> ne oldu?</p>`);
        const row = document.createElement("div");
        row.className = "fund-choice-row";
        row.innerHTML = `
          <button id="payout-distribute-btn" class="btn-primary">💸 Kişilere Dağıtıldı</button>
          <button id="payout-pool-btn" class="btn-secondary">🏦 Havuza Aktar</button>
        `;
        footer.appendChild(row);
        document.getElementById("payout-distribute-btn").addEventListener("click", () => setPayoutAction(c, "distributed"));
        document.getElementById("payout-pool-btn").addEventListener("click", () => setPayoutAction(c, "pooled"));
      }
    }

    if (isAdmin()) {
      footer.insertAdjacentHTML("beforeend", `<p class="footer-note">Admin olarak sonuçları aşağıdan değiştirebilirsin:</p>`);
      appendResultRows(footer, c);
    }
    return;
  }

  // status: played, sonuçlar tam değil
  const fundLabel = c.fundingSource === "pool" ? "Havuzdan" : "Kullanıcılardan";
  if (!canEditResults) {
    footer.innerHTML = `<p class="footer-note">Kuponu <strong>${c.playedBy}</strong> oynattı (${fundLabel}). Sonuçları o (ya da admin) işaretleyecek.</p>`;
    if (isAdmin()) footer.appendChild(buildFundEditRow(c));
    return;
  }
  footer.insertAdjacentHTML("beforeend", `<p class="footer-note">${c.playedBy === currentUser ? "Kuponu sen oynattın" : "Admin olarak"} (${fundLabel}). Maçlar bitince sonuçları işaretle:</p>`);
  if (isAdmin()) footer.appendChild(buildFundEditRow(c));
  appendResultRows(footer, c);
}

function buildFundEditRow(c) {
  const wrap = document.createElement("div");
  wrap.className = "fund-edit-row";
  wrap.innerHTML = `
    <span class="fund-edit-label">★ Admin — kaynağı düzelt:</span>
    <button class="fund-edit-btn ${c.fundingSource === "players" ? "active" : ""}" data-source="players">👥 Kullanıcılardan</button>
    <button class="fund-edit-btn ${c.fundingSource === "pool" ? "active" : ""}" data-source="pool">🏦 Havuzdan</button>
  `;
  wrap.querySelectorAll(".fund-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => adminChangeFundingSource(c, btn.dataset.source));
  });
  return wrap;
}

async function adminChangeFundingSource(c, newSource) {
  if (newSource === c.fundingSource) return;
  const totals = couponTotals(c);
  try {
    if (c.fundingSource === "pool" && newSource === "players") {
      // Havuzdan düşülmüştü, geri iade et
      await updateDoc(poolRef, { balance: increment(totals.totalStake) });
    } else if (c.fundingSource === "players" && newSource === "pool") {
      if (poolBalance < totals.totalStake) {
        showToast(`Havuzda yeterli bakiye yok (Havuz: ${poolBalance.toFixed(0)}₺, Gerekli: ${totals.totalStake}₺)`);
        return;
      }
      await updateDoc(poolRef, { balance: increment(-totals.totalStake) });
    }
    await updateDoc(doc(db, "coupons", c.id), { fundingSource: newSource });
    showToast("Kaynak güncellendi ✔");
  } catch (err) {
    console.error(err);
    showToast("Güncellenemedi: " + (err.code || err.message));
  }
}

function appendResultRows(footer, c) {
  const wrap = document.createElement("div");
  couponRoster(c).forEach(user => {
    const m = c.matches[user];
    const result = c.results ? c.results[user] : null;
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `
      <span class="result-teams">${user}: ${escapeHtml(m.teams)}</span>
      <span class="result-btns">
        <button class="result-btn win-btn ${result === "tuttu" ? "active" : ""}" data-user="${user}" data-val="tuttu">Tuttu</button>
        <button class="result-btn lose-btn ${result === "tutmadi" ? "active" : ""}" data-user="${user}" data-val="tutmadi">Tutmadı</button>
      </span>
    `;
    wrap.appendChild(row);
  });
  footer.appendChild(wrap);
  footer.querySelectorAll(".result-btn").forEach(btn => {
    btn.addEventListener("click", () => setResult(c.id, btn.dataset.user, btn.dataset.val));
  });
}

async function deleteCoupon(couponId) {
  const c = couponsCache.find(x => x.id === couponId);
  const ok = window.confirm(`"${c ? c.displayName : couponId}" kuponunu kalıcı olarak silmek istediğine emin misin? Bu işlem geri alınamaz.`);
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "coupons", couponId));
  } catch (err) {
    console.error("Kupon silinemedi:", err);
    showToast("Silinemedi: " + (err.code || err.message || "bilinmeyen hata"));
    return;
  }
  if (unsubCouponDetail) unsubCouponDetail();
  showToast("Kupon silindi");
  switchView("home");
  document.querySelector('.nav-btn[data-view="home"]').classList.add("active");
}

async function markPlayed(c, source) {
  const totals = couponTotals(c);
  if (source === "pool") {
    if (poolBalance < totals.totalStake) {
      showToast(`Havuzda yeterli bakiye yok (Havuz: ${poolBalance.toFixed(0)}₺, Gerekli: ${totals.totalStake}₺)`);
      return;
    }
    try {
      await updateDoc(poolRef, { balance: increment(-totals.totalStake) });
    } catch (err) {
      console.error(err);
      showToast("Havuz güncellenemedi: " + (err.code || err.message));
      return;
    }
  }
  await updateDoc(doc(db, "coupons", c.id), {
    playedBy: currentUser,
    playedAt: serverTimestamp(),
    fundingSource: source
  });
  showToast(source === "pool" ? `Kupon havuzdan oynatıldı (-${totals.totalStake}₺)` : "Kupon onaylandı, iyi şanslar!");
}

async function setPayoutAction(c, action) {
  const totals = couponTotals(c);
  if (action === "pooled") {
    try {
      await updateDoc(poolRef, { balance: increment(totals.payout) });
    } catch (err) {
      console.error(err);
      showToast("Havuz güncellenemedi: " + (err.code || err.message));
      return;
    }
  }
  await updateDoc(doc(db, "coupons", c.id), { payoutAction: action });
  showToast(action === "pooled" ? `+${totals.payout.toFixed(0)}₺ havuza eklendi` : "Kazanç dağıtıldı olarak işaretlendi");
}

async function setResult(couponId, user, val) {
  await updateDoc(doc(db, "coupons", couponId), {
    [`results.${user}`]: val
  });
}

/* ============================================================
   MATCH MODAL
   ============================================================ */
function openMatchModal(targetUser, existingMatch, couponId) {
  activeCouponId = couponId || activeCouponId;
  modalTargetUser = targetUser;
  document.getElementById("input-teams").value = existingMatch ? existingMatch.teams : "";
  document.getElementById("input-day").value = existingMatch ? (existingMatch.day || "") : "";
  document.getElementById("input-time").value = existingMatch ? (existingMatch.time || "") : "";
  document.getElementById("input-prediction").value = existingMatch ? existingMatch.prediction : "";
  document.getElementById("input-odds").value = existingMatch ? existingMatch.odds : "";
  document.getElementById("input-amount").value = existingMatch ? existingMatch.amount : "";
  document.getElementById("modal-error").classList.add("hidden");
  const heading = document.querySelector("#match-modal .ticket-eyebrow");
  if (targetUser === currentUser) {
    heading.textContent = existingMatch ? "Maçını düzenle" : "Maçını gir";
  } else {
    heading.textContent = `${targetUser} adına düzenle (Admin)`;
  }
  document.getElementById("match-modal").classList.remove("hidden");
}
function closeMatchModal() {
  document.getElementById("match-modal").classList.add("hidden");
}

async function submitMatch() {
  const teams = document.getElementById("input-teams").value.trim();
  const day = document.getElementById("input-day").value;
  const time = document.getElementById("input-time").value;
  const prediction = document.getElementById("input-prediction").value.trim();
  const odds = parseFloat(document.getElementById("input-odds").value);
  const amount = parseFloat(document.getElementById("input-amount").value);
  const errEl = document.getElementById("modal-error");

  if (!teams || !day || !time || !prediction || !odds || !amount || amount <= 0) {
    errEl.textContent = "Tüm alanları doğru şekilde doldur.";
    errEl.classList.remove("hidden");
    return;
  }

  await updateDoc(doc(db, "coupons", activeCouponId), {
    [`matches.${modalTargetUser}`]: {
      teams, day, time, prediction, odds, amount,
      enteredAt: serverTimestamp()
    }
  });
  closeMatchModal();
  showToast("Maç kaydedildi ✔");
}

/* ============================================================
   LEADERBOARD (Haftalık / Aylık)
   ============================================================ */
function computeUserStatsInRange(rangeStart, rangeEnd) {
  const stats = {};
  USERS.forEach(u => stats[u] = { user: u, entered: 0, won: 0, amount: 0, wonOddsSum: 0 });

  couponsCache.forEach(c => {
    if (!c.dateKey) return;
    const d = parseDateKey(c.dateKey);
    if (d < rangeStart || d > rangeEnd) return;
    USERS.forEach(u => {
      userEntries(c, u).forEach(e => {
        stats[u].entered++;
        stats[u].amount += e.amount;
        if (e.res === "tuttu") { stats[u].won++; stats[u].wonOddsSum += e.odds; }
      });
    });
  });

  return stats;
}

function metricValue(stat, metric) {
  switch (metric) {
    case "entered": return stat.entered;
    case "won": return stat.won;
    case "hitrate": return stat.entered ? Math.round((stat.won / stat.entered) * 100) : 0;
    case "amount": return stat.amount;
    case "oddsproduct": return stat.won > 0 ? Number(stat.wonOddsSum.toFixed(2)) : 0;
    default: return 0;
  }
}

function computeLeaderboard(rangeStart, rangeEnd) {
  const stats = computeUserStatsInRange(rangeStart, rangeEnd);
  return Object.values(stats).sort((a, b) => {
    if (b.won !== a.won) return b.won - a.won;
    return b.wonOddsSum - a.wonOddsSum;
  });
}

const MEDALS = ["🥇", "🥈", "🥉"];
const RANK_CLASSES = ["lb-gold", "lb-silver", "lb-bronze"];

function renderLeaderboardList(elId, rows) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = "";
  rows.forEach((r, i) => {
    const rankClass = RANK_CLASSES[i] || "lb-plain";
    const medal = MEDALS[i] || String(i + 1);
    const winRate = r.entered ? Math.round((r.won / r.entered) * 100) : null;
    const oddsLabel = r.won > 0 ? r.wonOddsSum.toFixed(2) : "—";
    const row = document.createElement("div");
    row.className = "lb-row";
    row.innerHTML = `
      <span class="lb-medal ${rankClass}">${medal}</span>
      <div class="lb-info">
        <div class="lb-name">${r.user}${r.user === ADMIN_USER ? " ★" : ""}</div>
        <div class="lb-stats-row">
          <span class="lb-chip">${r.entered} maç</span>
          <span class="lb-chip">${r.won} kazandı</span>
          <span class="lb-chip">Oran ${oddsLabel}</span>
          ${winRate !== null ? `<span class="lb-chip lb-chip-hit">%${winRate}</span>` : ""}
        </div>
      </div>
    `;
    el.appendChild(row);
  });
}

function renderLeaderboards() {
  const now = new Date();
  const mStart = startOfMonth(now), mEnd = endOfMonth(now);

  const allRangeEl = document.getElementById("lb-week-range");
  const monthRangeEl = document.getElementById("lb-month-range");
  if (allRangeEl) allRangeEl.textContent = "Başlangıçtan bugüne";
  if (monthRangeEl) monthRangeEl.textContent = `${TR_MONTHS[now.getMonth()]} ${now.getFullYear()}`;

  renderLeaderboardList("lb-week-list", computeLeaderboard(new Date(2000, 0, 1), new Date(2100, 0, 1)));
  renderLeaderboardList("lb-month-list", computeLeaderboard(mStart, mEnd));
}

/* ============================================================
   KASAYA BORÇ + KASADAKİ PAY
   ============================================================ */
// Havuzdan (kasadan) oynanıp KAYBEDİLEN her kuponda, kaybeden kişi(ler)
// kazananların yatırdığı tutarı kasaya geri ödemekle yükümlü (Kural 4).
// Bu borç kasadan otomatik düşülmüyor — burada sadece ne kadar borçlu
// olduğu hesaplanıp gösteriliyor.
function computeRawDebts() {
  const debtByUser = {};
  couponsCache.forEach(c => {
    if (c.fundingSource !== "pool") return;
    if (couponStatusInfo(c).key !== "lost") return;
    if (isSistem(c)) {
      const b = sistemBorclar(c);
      Object.keys(b.perUser).forEach(u => { if (b.perUser[u].debt > 0) debtByUser[u] = (debtByUser[u] || 0) + b.perUser[u].debt; });
      return;
    }
    const roster = couponRoster(c);
    const winners = roster.filter(u => c.results && c.results[u] === "tuttu");
    const losers = roster.filter(u => c.results && c.results[u] === "tutmadi");
    if (losers.length === 0 || winners.length === 0) return;
    const winnersStakeTotal = winners.reduce((sum, u) => sum + Number((c.matches[u] && c.matches[u].amount) || 0), 0);
    const perLoserShare = winnersStakeTotal / losers.length;
    losers.forEach(u => { debtByUser[u] = (debtByUser[u] || 0) + perLoserShare; });
  });
  return debtByUser;
}

// Bir kişinin borcunun kupon kupon dökümü (Detaylar paneli için).
function computeDebtDetails(user) {
  const items = [];
  couponsCache.forEach(c => {
    if (c.fundingSource !== "pool") return;
    if (couponStatusInfo(c).key !== "lost") return;
    if (isSistem(c)) {
      const b = sistemBorclar(c);
      const pu = b.perUser[user];
      if (!pu || pu.debt <= 0) return;
      items.push({ coupon: c, sistem: true, b, mine: c.matches[user] || null, share: pu.debt, failedLegs: pu.failedLegs });
      return;
    }
    const roster = couponRoster(c);
    const winners = roster.filter(u => c.results && c.results[u] === "tuttu");
    const losers = roster.filter(u => c.results && c.results[u] === "tutmadi");
    if (losers.length === 0 || winners.length === 0) return;
    if (!losers.includes(user)) return;
    const winnersStakeTotal = winners.reduce((sum, u) => sum + Number((c.matches[u] && c.matches[u].amount) || 0), 0);
    items.push({
      coupon: c,
      mine: c.matches[user] || null,
      winners: winners.map(u => ({ user: u, amount: Number((c.matches[u] && c.matches[u].amount) || 0) })),
      losers,
      winnersStakeTotal,
      share: winnersStakeTotal / losers.length
    });
  });
  // Yapılan borç ödemeleri en eski borçtan başlayarak kapatılır; tamamen ödenen
  // kuponlar listeden çıkar, sadece hâlâ ödenmemiş (veya kısmen ödenmiş) olanlar kalır.
  items.sort((a, b) => String(a.coupon.dateKey || "").localeCompare(String(b.coupon.dateKey || "")));
  let paidLeft = paymentsSum("debt_payment", user);
  const open = [];
  items.forEach(i => {
    const covered = Math.min(paidLeft, i.share);
    paidLeft -= covered;
    const remaining = i.share - covered;
    if (remaining > 0.005) open.push({ ...i, covered, remaining });
  });
  open.reverse(); // en yeni üstte
  return open;
}

const debtOpen = new Set();   // "Detaylar" açık olan kişiler (yeniden çizimde korunur)

function ensureDebtStyle() {
  if (document.getElementById("debt-detail-style")) return;
  const st = document.createElement("style");
  st.id = "debt-detail-style";
  st.textContent = `
    .debt-detail-btn{background:transparent;border:1px solid currentColor;border-radius:8px;padding:4px 10px;font-size:.78rem;cursor:pointer;color:inherit;opacity:.85}
    .debt-detail-btn:hover{opacity:1}
    .debt-detail{margin:2px 0 10px;padding:10px 12px;border-radius:10px;background:rgba(128,128,128,.10);font-size:.88rem;line-height:1.45}
    .debt-detail .dd-sum{display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:8px;font-weight:600}
    .debt-detail .dd-item{padding:8px 0;border-top:1px solid rgba(128,128,128,.25)}
    .debt-detail .dd-head{display:flex;justify-content:space-between;gap:8px;font-weight:600}
    .debt-detail .dd-loss{color:#e5484d;white-space:nowrap}
    .debt-detail .dd-meta{opacity:.8;font-size:.82rem}
    .debt-detail .dd-pay{color:#2e9e5b}
    .debt-detail .dd-empty{opacity:.75}
  `;
  document.head.appendChild(st);
}

function debtDetailHtml(user) {
  const items = computeDebtDetails(user);
  const left = items.reduce((s, i) => s + i.remaining, 0);
  if (items.length === 0) {
    return `<div class="dd-empty">${escapeHtml(user)} için ödenmemiş borç yok.</div>`;
  }
  const dateTxt = (k) => { if (!k) return "?"; const [y, m, d] = String(k).split("-"); return `${d}.${m}.${y}`; };
  const rows = items.map(i => {
    if (i.sistem) {
      const c = i.coupon, b = i.b;
      const part2 = i.covered > 0.005 ? ` · ${i.covered.toFixed(0)}₺ ödenmiş, kalan ${i.remaining.toFixed(0)}₺` : "";
      const bad = i.failedLegs.map(l => `${escapeHtml(l.teams)} (${escapeHtml(String(l.prediction || "?"))}, oran ${Number(l.odds).toFixed(2)})`).join("; ");
      return `
      <div class="dd-item">
        <div class="dd-head">
          <span>${escapeHtml(c.displayName || "Kupon")} · ${dateTxt(c.dateKey)} <span class="sm-badge">SİSTEM</span></span>
          <span class="dd-loss">-${i.remaining.toFixed(0)}₺</span>
        </div>
        <div class="dd-meta">Sistem: ${b.ks.join("+")} · Yatırılan ${b.stake.toFixed(0)}₺ · Gelen ${b.payout.toFixed(0)}₺ · Zarar ${b.loss.toFixed(0)}₺</div>
        <div class="dd-meta">Tutmayan maçların: ${bad}</div>
        <div class="dd-meta">Toplam ${b.totalFailed} maç tutmadı, senin ${i.failedLegs.length} maçın → zarar payın ${i.failedLegs.length}/${b.totalFailed}${part2}</div>
      </div>`;
    }
    const c = i.coupon, m = i.mine;
    const w = i.winners.map(x => `${escapeHtml(x.user)} (${x.amount.toFixed(0)}₺)`).join(", ");
    const shared = i.losers.length > 1 ? ` · ${i.losers.length} kişi tutturamadı (${i.losers.map(escapeHtml).join(", ")}), borç bölüşüldü` : "";
    const part = i.covered > 0.005 ? ` · ${i.covered.toFixed(0)}₺ ödenmiş, kalan ${i.remaining.toFixed(0)}₺` : "";
    return `
      <div class="dd-item">
        <div class="dd-head">
          <span>${escapeHtml(c.displayName || "Kupon")} · ${dateTxt(c.dateKey)}</span>
          <span class="dd-loss">-${i.remaining.toFixed(0)}₺</span>
        </div>
        ${m ? `<div class="dd-meta">Maç: ${escapeHtml(m.teams || "?")}${m.day || m.time ? ` (${escapeHtml([m.day, m.time].filter(Boolean).join(" "))})` : ""}</div>
        <div class="dd-meta">Tahmin: ${escapeHtml(String(m.prediction || "?"))} · Oran ${escapeHtml(String(m.odds || "?"))} · Yatırdığı: ${Number(m.amount || 0).toFixed(0)}₺ · <strong>Tutmadı</strong></div>` : ""}
        <div class="dd-meta">Tutturanlar: ${w} → toplam ${i.winnersStakeTotal.toFixed(0)}₺${shared}${part}</div>
      </div>`;
  }).join("");
  return `
    <div class="dd-sum"><span>Ödenmemiş borç: ${left.toFixed(0)}₺</span></div>
    ${rows}`;
}

function paymentsSum(type, user) {
  return paymentsCache
    .filter(p => p.type === type && p.user === user)
    .reduce((s, p) => s + Number(p.amount || 0), 0);
}

// Net borç = kupon kayıplarından doğan ham borç − bugüne kadar yapılan borç ödemeleri
function computeDebts() {
  const raw = computeRawDebts();
  const net = {};
  Object.keys(raw).forEach(u => {
    net[u] = Math.max(0, raw[u] - paymentsSum("debt_payment", u));
  });
  return net;
}

function subscribePayments() {
  if (unsubPayments) unsubPayments();
  const q = query(collection(db, "payments"), orderBy("date", "desc"));
  unsubPayments = onSnapshot(q, (snap) => {
    paymentsCache = [];
    snap.forEach(d => paymentsCache.push({ id: d.id, ...d.data() }));
    renderDebtAndShare();
  }, (err) => console.error("Ödemeler okunamadı:", err));
}

async function recordPayment(type, user, defaultAmount) {
  const isDebt = type === "debt_payment";
  const input = window.prompt(
    isDebt
      ? `${user} toplam ${Math.round(defaultAmount)}₺ borçlu.\nBugün ödenen tutarı yazın (tamamı veya bir kısmı, ₺):`
      : `${user} için pay ödemesi tutarı (₺):`,
    String(Math.round(defaultAmount))
  );
  if (input === null) return;
  const amount = parseFloat(String(input).replace(",", "."));
  if (isNaN(amount) || amount <= 0) { showToast("Geçersiz tutar"); return; }
  if (isDebt && amount > defaultAmount + 0.5) {
    showToast(`Tutar borçtan fazla olamaz (${Math.round(defaultAmount)}₺)`);
    return;
  }
  if (!isDebt && amount > poolBalance) {
    showToast(`Kasada yeterli bakiye yok (${poolBalance.toFixed(0)}₺)`);
    return;
  }
  const kalan = Math.max(0, defaultAmount - amount);
  const msg = isDebt
    ? `${user} kasaya ${amount}₺ borç ödedi.${kalan > 0.5 ? ` Kalan borç: ${Math.round(kalan)}₺.` : " Borç tamamen kapanacak."} Kaydedilsin mi?`
    : `${user} kişisine kasadan ${amount}₺ ödendi. Kaydedilsin mi?`;
  if (!window.confirm(msg)) return;
  try {
    await setDoc(doc(collection(db, "payments")), {
      type, user, amount,
      date: serverTimestamp(),
      recordedBy: currentUser
    });
    await updateDoc(poolRef, { balance: increment(isDebt ? amount : -amount) });
    showToast("Ödeme kaydedildi ✔");
  } catch (err) {
    console.error(err);
    showToast("Kaydedilemedi: " + (err.code || err.message));
  }
}

function renderDebtAndShare() {
  const debtList = document.getElementById("debt-list");
  const shareList = document.getElementById("share-list");
  const historyEl = document.getElementById("payment-history");
  if (!debtList || !shareList) return;

  const N = USERS.length;
  const rawDebts = computeRawDebts();      // kupon kayıplarından doğan toplam borç
  const debtByUser = computeDebts();       // kalan (ödenmemiş) borç
  const totalRaw = USERS.reduce((s, u) => s + (rawDebts[u] || 0), 0);
  const paidOut = {};
  USERS.forEach(u => { paidOut[u] = paymentsSum("share_payout", u); });
  const totalPaidOut = USERS.reduce((s, u) => s + paidOut[u], 0);
  // Ödenen borçlar kasaya girer ama kimsenin payına ayrıca eklenmez (borç zaten oluştuğu anda
  // diğer kişilerin payına yazılmıştı). Bu yüzden eşit pay hesabında kasadan düşülür.
  const appliedPay = {};
  USERS.forEach(u => { appliedPay[u] = Math.min(paymentsSum("debt_payment", u), rawDebts[u] || 0); });
  const totalAppliedPay = USERS.reduce((s, u) => s + appliedPay[u], 0);
  // Eşit paylaşılacak para: kasada kalan + kişilere ödenmiş paylar - ödenen borçlar
  const grossTotal = poolBalance + totalPaidOut - totalAppliedPay;
  const baseShare = N > 0 ? grossTotal / N : 0;

  debtList.innerHTML = "";
  USERS.forEach(u => {
    const debt = debtByUser[u] || 0;
    const cls = debt > 0 ? "is-debt" : "is-zero";
    const row = document.createElement("div");
    row.className = "simple-row";
    row.innerHTML = `
      <span class="simple-row-name">${u}</span>
      <span class="simple-row-actions">
        <span class="simple-row-value ${cls}">${debt > 0 ? "-" : ""}${debt.toFixed(0)}₺</span>
        <button class="debt-detail-btn" data-detail-user="${escapeHtml(u)}">${debtOpen.has(u) ? "Gizle" : "Detaylar"}</button>
        ${isAdmin() && debt > 0 ? `<button class="pay-btn" data-type="debt_payment" data-user="${u}" data-amount="${debt}">Borç Öde</button>` : ""}
      </span>
    `;
    debtList.appendChild(row);
    if (debtOpen.has(u)) {
      const det = document.createElement("div");
      det.className = "debt-detail";
      det.innerHTML = debtDetailHtml(u);
      debtList.appendChild(det);
    }
  });
  ensureDebtStyle();
  debtList.querySelectorAll(".debt-detail-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const u = btn.dataset.detailUser;
      if (debtOpen.has(u)) debtOpen.delete(u); else debtOpen.add(u);
      renderDebtAndShare();
    });
  });

  shareList.innerHTML = "";
  const calcLines = [];
  USERS.forEach(u => {
    const debt = debtByUser[u] || 0;                                   // kendi kalan borcu
    const credit = N > 1 ? (totalRaw - (rawDebts[u] || 0)) / (N - 1) : 0; // diğerlerinin borcundan gelen
    const fair = baseShare - debt + credit;
    const share = fair - paidOut[u];
    calcLines.push(
      `<li><strong>${u}:</strong> ${baseShare.toFixed(0)} (eşit pay) − ${debt.toFixed(0)} (kendi borcu) + ${credit.toFixed(0)} (diğerlerinin borcundan)` +
      `${paidOut[u] > 0 ? ` − ${paidOut[u].toFixed(0)} (daha önce ödenen pay)` : ""} = <strong>${share.toFixed(0)}₺</strong></li>`
    );
    const row = document.createElement("div");
    row.className = "simple-row";
    row.innerHTML = `
      <span class="simple-row-name">${u}</span>
      <span class="simple-row-actions">
        <span class="simple-row-value is-share">${share.toFixed(0)}₺</span>
        ${isAdmin() && share > 0 ? `<button class="pay-btn" data-type="share_payout" data-user="${u}" data-amount="${share}">Payı Öde</button>` : ""}
      </span>
    `;
    shareList.appendChild(row);
  });

  const totalRow = document.createElement("div");
  totalRow.className = "simple-row simple-row-total";
  totalRow.innerHTML = `
    <span class="simple-row-name">Toplam Kasa</span>
    <span class="simple-row-value is-share">${poolBalance.toFixed(0)}₺</span>
  `;
  shareList.appendChild(totalRow);

  const note = document.createElement("div");
  note.className = "debt-note";
  note.innerHTML = `
    <details>
      <summary><strong>Bu paylar nasıl hesaplanıyor?</strong></summary>
      <p><strong>Önce kasa nasıl işler?</strong></p>
      <ol>
        <li><strong>Kasaya para girişi:</strong> Kasaya sadece şunlar para ekler: tutan bir kuponun kazancının "Havuza Aktar" ile kasaya alınması, zararlı sistem kuponunda geri gelen paranın "Havuza Aktar" ile alınması, kişilerin borç ödemesi ve adminin elle yaptığı düzeltme.</li>
        <li><strong>Kasadan para çıkışı:</strong> Kupon "Havuzdan" oynatılınca kupon tutarı kasadan düşer. Ayrıca bir kişiye "Payı Öde" yapılınca ödenen tutar çıkar. Sistem kuponları her zaman havuzdan oynanır.</li>
        <li><strong>Kaynak seçimi:</strong> Normal kuponda kuponu oynatan kişi parayı "Kullanıcılardan" ya da "Havuzdan" seçer. <em>Kullanıcılardan</em> seçilirse herkes kendi cebinden öder; kasaya, borca ve paya hiçbir etkisi olmaz. <em>Havuzdan</em> seçilirse tutar kasadan düşer ve aşağıdaki borç kuralı işler. Admin, oynatılmış bir kuponun kaynağını sonradan düzeltebilir; kasaya fark otomatik iade edilir ya da düşülür.</li>
        <li><strong>Tutan kupon:</strong> Kazanç iki yoldan biriyle işlenir. "Havuza Aktar" derseniz kazanç kasaya eklenir ve herkesin payına eşit yansır. "Kişilere Dağıtıldı" derseniz para kasaya girmez, kişiler aralarında paylaşmış sayılır. Bir seçeneği seçmezseniz kasa kazanç kadar eksik görünür.</li>
        <li><strong>Tutmayan kupon (havuzdan):</strong> Kupon tutarı zaten kasadan çıkmıştı. Tutmayan kişi kazananların yatırdığı tutarı öder. Tutmayan birden fazla kişi varsa bu tutar aralarında eşit bölünür. Bu borç kasaya otomatik girmez; kişi ödeyince "Borç Öde" ile kasaya girer. Borç kişinin ödemesine kadar payından düşer, kalan kişilerin payına eşit eklenir.</li>
        <li><strong>Parçalı ödeme:</strong> Borcun tamamı ya da bir kısmı ödenebilir. Ödemeler en eski borçtan başlayarak kapatır; "Detaylar"da sadece ödenmemiş kuponlar (ve kısmen ödenenlerin kalanı) görünür. Borcu tamamen biten kişinin Detaylar paneli boş olur; yeni borç yapınca yalnızca yeni kuponlar listelenir.</li>
      </ol>
      <p><strong>Pay hesabı:</strong></p>
      <ol>
        <li><strong>Eşit pay:</strong> Kasadaki para herkese eşit bölünür. Daha önce kişilere ödenen paylar toplama geri eklenir, borç ödemeleri ise çıkarılır (nedeni 4. maddede).</li>
        <li><strong>Borç:</strong> Havuzdan oynanan bir kupon tutmayınca, tutmayan kişi kazananların yatırdığı tutarı öder. Bu borç, o kişinin payından düşer.</li>
        <li><strong>Diğerlerinin payı:</strong> Düşen borç, borçlu dışındaki kişilere eşit bölünerek payına eklenir. Borç oluştuğu anda yazılır, ödenmesi beklenmez.</li>
        <li><strong>Borç ödenince:</strong> Para kasaya girer ama kimsenin payına ayrıca eklenmez, çünkü diğer kişilere zaten yazılmıştı. Sadece ödeyen kişinin borç kesintisi kalkar. Böylece ödeme yapan kişinin payı tam ödediği kadar artar, diğerlerinin payı değişmez.</li>
        <li><strong>Pay ödenince:</strong> Kasadan çıkan para o kişinin payından düşülür.</li>
      </ol>
      <p><strong>Formül:</strong> Pay = eşit pay − kendi borcu + (diğer kişilerin toplam borcu ÷ ${Math.max(N - 1, 1)}) − daha önce ödenen pay</p>
      <p><strong>Şu anki hesap (kasa ${poolBalance.toFixed(0)}₺${totalAppliedPay > 0 ? `, ödenen borç ${totalAppliedPay.toFixed(0)}₺ eşit paydan çıkarıldı` : ""}):</strong></p>
      <ul>${calcLines.join("")}</ul>
      <p><strong>Sistem kuponunda her şey nasıl hesaplanır?</strong></p>
      <ol>
        <li><strong>Giriş:</strong> Her kişi 2 maç girer, tutar yazmaz. Oynayan kişi sistemleri (örn. 3+4+5+6) ve oynadığı <em>toplam tutarı</em> seçer. Para her zaman ortak kasadan çıkar; kasada yeterli para yoksa kupon oynanamaz.</li>
        <li><strong>Kolon:</strong> n maç içinden k'lı sistem, n'in k'lı kombinasyonları kadar kolondur. 6 maçta 4'lü = 15, 5'li = 6, 3'lü = 20, 6'lı = 1 kolon. Birden fazla sistem seçilirse kolonlar toplanır. Kolon başı tutar = toplam tutar ÷ kolon sayısı.</li>
        <li><strong>Gelen kazanç:</strong> Bir kolon, içindeki bütün maçlar tutarsa kazanır; getirisi o kolondaki oranların çarpımı × kolon başı tutardır. Gelen kazanç, kazanan kolonların getirisinin toplamıdır. İptal/iade olan maçın oranı 1 sayılır. Nesine'nin ödediği tutar farklıysa "Gelen kazancı elle gir" ile düzeltilir.</li>
        <li><strong>Tuttu mu, tutmadı mı:</strong> Gelen kazanç yatırılan tutara eşit ya da fazlaysa kupon <em>Tuttu</em>, azsa <em>Tutmadı</em> sayılır. Tuttuysa kazanç, normal kuponlardaki gibi "kişilere dağıtıldı" ya da "havuza aktar" diye işlenir.</li>
        <li><strong>Zarar:</strong> Zarar = yatırılan tutar − gelen kazanç. Zararlı bitse bile gelen para "Havuza Aktar" düğmesiyle kasaya geri eklenir; böylece kasadaki net kayıp tam olarak bu zarar kadar olur.</li>
        <li><strong>Zararın bölüşümü:</strong> Zarar, kişilerin <em>tutmayan maç sayısına</em> göre paylaştırılır. Kişinin borcu = zarar × (onun tutmayan maçı ÷ kupondaki toplam tutmayan maç). Hiç maçı yatmayan kişiye borç yazılmaz. Maçı iptal olanlar tutmayan sayılmaz.</li>
        <li><strong>Borcun işleyişi:</strong> Bu borç da normal borçla aynıdır: "Kasaya Borç" listesinde görünür, "Detaylar"da hangi maçlar yüzünden ne kadar olduğu yazar, parçalı ödenebilir. Borç oluştuğu anda borçlu dışındaki kişilerin payına da eşit bölünerek yazılır (yukarıdaki formül aynen geçerli).</li>
      </ol>
      <p><strong>Örnek:</strong> 6 maç, 4+5 sistem = 21 kolon, toplam 210₺ → kolon başı 10₺. Mahir'in ve Cenk'in birer maçı yattı, kalan 4 maç tuttu (oranlar çarpımı 7,56). Sadece 1 kolon kazandığı için gelen = 75,6₺, zarar = 134,4₺. Toplam 2 maç tutmadı: Mahir 1/2 → 67,2₺, Cenk 1/2 → 67,2₺ borç; Nihat'ın maçları tuttuğu için borcu yok.</p>
    </details>
  `;
  shareList.appendChild(note);

  document.querySelectorAll(".pay-btn").forEach(btn => {
    btn.addEventListener("click", () => recordPayment(btn.dataset.type, btn.dataset.user, Number(btn.dataset.amount)));
  });

  if (historyEl) {
    historyEl.innerHTML = "";
    if (paymentsCache.length === 0) {
      historyEl.innerHTML = `<p class="stats-empty">Henüz kayıtlı ödeme yok.</p>`;
    } else {
      paymentsCache.forEach(p => {
        const isDebt = p.type === "debt_payment";
        const row = document.createElement("div");
        row.className = "payment-row";
        row.innerHTML = `
          <div class="payment-main">
            <div class="payment-title">${escapeHtml(p.user)} · ${isDebt ? "Borç ödemesi" : "Pay ödemesi"}</div>
            <div class="payment-meta">${formatTimestamp(p.date)} · Kaydeden: ${escapeHtml(p.recordedBy || "?")}</div>
          </div>
          <span class="payment-amount ${isDebt ? "is-in" : "is-out"}">${isDebt ? "+" : "-"}${Number(p.amount).toFixed(0)}₺</span>
        `;
        historyEl.appendChild(row);
      });
    }
  }
}

/* ============================================================
   CHARTS
   ============================================================ */
function getPeriodRange(period) {
  const now = new Date();
  if (period === "week") return { start: startOfWeek(now), end: endOfWeek(now) };
  if (period === "month") return { start: startOfMonth(now), end: endOfMonth(now) };
  return { start: new Date(2000, 0, 1), end: new Date(2100, 0, 1) };
}

function getTrendBuckets(period) {
  const now = new Date();
  if (period === "week") {
    const start = startOfWeek(now);
    const labels = ["Pzt", "Sal", "Çrş", "Prş", "Cum", "Cmt", "Paz"];
    return labels.map((label, i) => {
      const end = new Date(start);
      end.setDate(start.getDate() + i);
      end.setHours(23, 59, 59, 999);
      return { label, rangeStart: start, rangeEnd: end };
    });
  }
  if (period === "month") {
    const start = startOfMonth(now);
    const daysInMonth = endOfMonth(now).getDate();
    const totalWeeks = Math.ceil(daysInMonth / 7);
    const buckets = [];
    for (let w = 1; w <= totalWeeks; w++) {
      const endDay = Math.min(w * 7, daysInMonth);
      const rangeEnd = new Date(start.getFullYear(), start.getMonth(), endDay, 23, 59, 59, 999);
      buckets.push({ label: `${w}. Hafta`, rangeStart: start, rangeEnd });
    }
    return buckets;
  }
  // all — veri var olan her ay için tek tek kova
  const veryStart = new Date(2000, 0, 1);
  let earliest = now;
  couponsCache.forEach(c => {
    if (c.dateKey) { const d = parseDateKey(c.dateKey); if (d < earliest) earliest = d; }
  });
  const cursor = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 1);
  const buckets = [];
  while (cursor <= last) {
    const rangeEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);
    buckets.push({ label: `${TR_MONTHS[cursor.getMonth()].slice(0, 3)} ${String(cursor.getFullYear()).slice(2)}`, rangeStart: veryStart, rangeEnd });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  if (buckets.length === 0) {
    buckets.push({ label: `${TR_MONTHS[now.getMonth()].slice(0, 3)} ${String(now.getFullYear()).slice(2)}`, rangeStart: veryStart, rangeEnd: endOfMonth(now) });
  }
  return buckets;
}

function renderCharts() {
  if (typeof Chart === "undefined") return;

  // ---- Çubuk grafik: karşılaştırma ----
  const { start, end } = getPeriodRange(chartPeriod);
  const stats = Object.values(computeUserStatsInRange(start, end));
  const barRows = stats
    .map(s => ({ user: s.user, value: metricValue(s, chartMetric) }))
    .sort((a, b) => b.value - a.value);

  const barCtx = document.getElementById("chart-bar");
  if (barCtx) {
    if (barChartInstance) barChartInstance.destroy();
    barChartInstance = new Chart(barCtx, {
      type: "bar",
      data: {
        labels: barRows.map(r => r.user),
        datasets: [{
          label: METRIC_LABELS[chartMetric],
          data: barRows.map(r => r.value),
          backgroundColor: barRows.map(r => USER_COLORS[r.user] || "#999"),
          borderRadius: 6,
          maxBarThickness: 56
        }]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 } },
          y: { grid: { display: false } }
        }
      }
    });
  }

  // ---- Çizgi grafik: kümülatif trend ----
  const buckets = getTrendBuckets(chartPeriod);
  const lineDatasets = USERS.map(u => ({
    label: u,
    data: buckets.map(b => {
      const s = computeUserStatsInRange(b.rangeStart, b.rangeEnd)[u];
      return metricValue(s, chartMetric);
    }),
    borderColor: USER_COLORS[u] || "#999",
    backgroundColor: USER_COLORS[u] || "#999",
    tension: 0.3,
    pointRadius: 3
  }));

  const lineCtx = document.getElementById("chart-line");
  if (lineCtx) {
    if (lineChartInstance) lineChartInstance.destroy();
    lineChartInstance = new Chart(lineCtx, {
      type: "line",
      data: { labels: buckets.map(b => b.label), datasets: lineDatasets },
      options: {
        responsive: true,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } }
        }
      }
    });
  }
}

/* ============================================================
   STATS
   ============================================================ */
function renderStats() {
  renderLeaderboards();
  renderDebtAndShare();
  renderCharts();

  const finished = couponsCache.filter(c => couponStatusInfo(c).key === "won" || couponStatusInfo(c).key === "lost");
  const wonCount = finished.filter(c => couponStatusInfo(c).key === "won").length;
  const winRate = finished.length ? Math.round((wonCount / finished.length) * 100) : 0;

  document.getElementById("overall-stats").innerHTML = `
    <div class="stat-box"><div class="stat-value">${couponsCache.length}</div><div class="stat-label">Toplam Kupon</div></div>
    <div class="stat-box"><div class="stat-value">${finished.length}</div><div class="stat-label">Sonuçlanan</div></div>
    <div class="stat-box"><div class="stat-value">${wonCount}</div><div class="stat-label">Tutan</div></div>
    <div class="stat-box"><div class="stat-value">%${winRate}</div><div class="stat-label">Genel İsabet</div></div>
  `;

  const playerGrid = document.getElementById("player-stats");
  playerGrid.innerHTML = "";
  USERS.forEach(user => {
    let matchCount = 0, oddsSum = 0, oddsCount = 0, resultCount = 0, hitCount = 0, amountSum = 0;
    couponsCache.forEach(c => {
      userEntries(c, user).forEach(e => {
        matchCount++; oddsSum += e.odds; oddsCount++; amountSum += e.amount;
        if (e.res && e.res !== "iptal") { resultCount++; if (e.res === "tuttu") hitCount++; }
      });
    });
    const avgOdds = oddsCount ? (oddsSum / oddsCount).toFixed(2) : "—";
    const hitRate = resultCount ? Math.round((hitCount / resultCount) * 100) : null;
    const card = document.createElement("div");
    card.className = "player-card";
    card.innerHTML = `
      <div class="player-card-name">${user}${user === ADMIN_USER ? " ★" : ""}</div>
      <div class="player-stat-line"><span>Girdiği maç</span><span>${matchCount}</span></div>
      <div class="player-stat-line"><span>Toplam yatırım</span><span>${Math.round(amountSum * 100) / 100}₺</span></div>
      <div class="player-stat-line"><span>Ortalama oran</span><span>${avgOdds}</span></div>
      <div class="player-stat-line"><span>Kendi isabet oranı</span><span>${hitRate === null ? "—" : "%" + hitRate}</span></div>
    `;
    playerGrid.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ============================================================
   RULES
   ============================================================ */
const RULES = [
  "Her kuponda her kişi sadece 1 maç verebilir.",
  "Verilen maçın oranı 2.00 ve üzeri olmalıdır.",
  "Kuponu oynayan son kişi, kuponu kaydeder ve toplam kupon tutarını gruba yazar.",
  "Kuponda maçı kaybeden kişi veya kişiler, kazanan kişilerin kupon ücretini öder.",
  "Kimse, kendi tuttuğu takıma, garanti gördüğü maçlarda dahi oynayamaz.",
  "Her ay en çok maç kaybeden kişi, bir kuponu tek başına ödeyerek oynar.",
  "Sistem kuponunda her kişi 2 maç verir; oynayan kişi sistemi ve toplam tutarı seçer, para ortak kasadan çıkar. Kupon zararda biterse zarar, kişilerin tutmayan maç sayısına göre paylaşılır."
];
const RULE_EMOJIS = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣"];

function renderRules() {
  const list = document.getElementById("rules-list");
  if (!list) return;
  list.innerHTML = "";
  RULES.forEach((text, i) => {
    const card = document.createElement("div");
    card.className = "rule-card";
    card.innerHTML = `
      <span class="rule-num">${RULE_EMOJIS[i] || (i + 1) + "."}</span>
      <span class="rule-text">${escapeHtml(text)}</span>
    `;
    list.appendChild(card);
  });
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
document.getElementById("back-to-names").addEventListener("click", () => {
  document.getElementById("pin-pad").classList.add("hidden");
  document.getElementById("name-select").classList.remove("hidden");
  document.getElementById("pin-error").classList.add("hidden");
  pinState.current = ""; pinState.first = ""; pinState.stage = "first"; pinState.busy = false;
  renderPinDots();
});

document.querySelectorAll(".key[data-k]").forEach(k => {
  k.addEventListener("click", () => handlePinDigit(k.dataset.k));
});
document.getElementById("pin-del").addEventListener("click", handlePinDelete);
document.getElementById("pin-submit").addEventListener("click", processPinComplete);

// Klavye desteği: rakam tuşları, Backspace ve Enter
document.addEventListener("keydown", (e) => {
  const padVisible = !document.getElementById("pin-pad").classList.contains("hidden");
  const loginVisible = document.getElementById("view-login").classList.contains("active");
  if (!padVisible || !loginVisible) return;
  if (e.key >= "0" && e.key <= "9") {
    handlePinDigit(e.key);
    e.preventDefault();
  } else if (e.key === "Backspace") {
    handlePinDelete();
    e.preventDefault();
  } else if (e.key === "Enter") {
    processPinComplete();
    e.preventDefault();
  }
});

document.getElementById("logout-btn").addEventListener("click", logout);

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    switchView(btn.dataset.view);
    if (btn.dataset.view === "stats") renderCharts();
  });
});

document.querySelectorAll("#chart-period-btns .filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#chart-period-btns .filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    chartPeriod = btn.dataset.period;
    renderCharts();
  });
});

document.querySelectorAll("#chart-metric-btns .filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#chart-metric-btns .filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    chartMetric = btn.dataset.metric;
    renderCharts();
  });
});

document.querySelectorAll(".matches-day-tabs .filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".matches-day-tabs .filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    matchesDay = btn.dataset.day;
    subscribeMatches();
  });
});

document.getElementById("new-coupon-btn").addEventListener("click", createNewCoupon);
document.getElementById("back-to-home").addEventListener("click", () => {
  if (unsubCouponDetail) unsubCouponDetail();
  switchView("home");
  document.querySelector('.nav-btn[data-view="home"]').classList.add("active");
});

document.getElementById("close-modal").addEventListener("click", closeMatchModal);
document.getElementById("submit-match").addEventListener("click", submitMatch);

/* ============================================================
   SİSTEM KUPON
   3-4 kişi, kişi başı 2 maç; oynayan kişi sistemi (3+4+5+6 gibi) ve toplam
   tutarı seçer, para HER ZAMAN ortak kasadan çıkar. Zarar, tutmayan maç
   sayısına göre paylaştırılır.
   ============================================================ */
const SISTEM_BACAK = 2;
const sistemForm = { couponId: null, ks: new Set(), stake: "", edit: false };

function isSistem(c) { return !!c && c.tur === "sistem"; }

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}
// e[k] = oranlardan k tanesinin çarpımlarının toplamı (her k'lı kolonun getirisi / birim)
function elemSym(odds) {
  const e = [1];
  odds.forEach(o => { for (let k = e.length; k >= 1; k--) e[k] = (e[k] || 0) + e[k - 1] * o; });
  return e;
}

function sistemBacaklar(c) {
  const out = [];
  couponRoster(c).forEach(u => {
    const m = c.matches ? c.matches[u] : null;
    if (!m || !m.legs) return;
    m.legs.forEach((l, i) => out.push({
      user: u, i, odds: Number(l.odds) || 1, teams: l.teams, day: l.day, time: l.time, prediction: l.prediction,
      res: (c.legRes && c.legRes[u] && c.legRes[u][i]) || null
    }));
  });
  return out;
}

function sistemHesap(c) {
  const legs = sistemBacaklar(c);
  const n = legs.length;
  const s = c.sistem || {};
  const ks = (s.ks || []).map(Number).filter(k => k >= 2 && k <= n).sort((a, b) => a - b);
  const stake = Number(s.stake) || 0;
  const kolon = ks.reduce((t, k) => t + comb(n, k), 0);
  const unit = kolon ? stake / kolon : 0;
  const eAll = elemSym(legs.map(l => l.odds));
  const maxPayout = unit * ks.reduce((t, k) => t + (eAll[k] || 0), 0);
  const tamam = n > 0 && legs.every(l => l.res);
  const win = legs.filter(l => l.res === "tuttu" || l.res === "iptal").map(l => (l.res === "iptal" ? 1 : l.odds));
  const eW = elemSym(win);
  const hesap = unit * ks.reduce((t, k) => t + (eW[k] || 0), 0);
  const tutanKolon = ks.reduce((t, k) => t + comb(win.length, k), 0);
  const manuel = s.odenenKazanc !== undefined && s.odenenKazanc !== null && s.odenenKazanc !== "" ? Number(s.odenenKazanc) : null;
  const payout = tamam ? Math.round((manuel !== null && !isNaN(manuel) ? manuel : hesap) * 100) / 100 : null;
  return { legs, n, ks, stake, kolon, unit, maxPayout, tamam, hesap, manuel, payout, tutanKolon };
}

// Zarar = yatırılan − gelen. Zarar, tutmayan maç sayısına göre bölünür.
function sistemBorclar(c) {
  const h = sistemHesap(c);
  const res = { ks: h.ks, stake: h.stake, payout: h.payout || 0, loss: 0, totalFailed: 0, perUser: {} };
  if (!h.tamam) return res;
  res.loss = Math.max(0, h.stake - h.payout);
  const failed = h.legs.filter(l => l.res === "tutmadi");
  res.totalFailed = failed.length;
  failed.forEach(l => {
    const pu = res.perUser[l.user] || (res.perUser[l.user] = { failedLegs: [], debt: 0 });
    pu.failedLegs.push(l);
  });
  if (res.loss > 0.005 && res.totalFailed > 0) {
    Object.keys(res.perUser).forEach(u => {
      res.perUser[u].debt = res.loss * res.perUser[u].failedLegs.length / res.totalFailed;
    });
  } else {
    Object.keys(res.perUser).forEach(u => { res.perUser[u].debt = 0; });
  }
  return res;
}

// İstatistikler için: bir kişinin bir kupondaki "maç" kayıtları (sistemde her bacak ayrı sayılır)
function userEntries(c, u) {
  const m = c.matches ? c.matches[u] : null;
  if (!m) return [];
  if (isSistem(c) && m.legs) {
    const nTot = sistemBacaklar(c).length || 1;
    const stake = c.playedBy ? Number(c.sistem && c.sistem.stake) || 0 : 0;
    return m.legs.map((l, i) => ({
      odds: Number(l.odds) || 0,
      amount: stake / nTot,
      res: (c.legRes && c.legRes[u] && c.legRes[u][i]) || null
    }));
  }
  return [{ odds: Number(m.odds) || 0, amount: Number(m.amount || 0), res: c.results ? c.results[u] || null : null }];
}

const trTL = (x) => (Math.round(x * 100) / 100).toLocaleString("tr-TR", { maximumFractionDigits: 2 });

/* ---------- stil ---------- */
function ensureSistemStyle() {
  if (document.getElementById("sistem-style")) return;
  const st = document.createElement("style");
  st.id = "sistem-style";
  st.textContent = `
    .sm-btn{display:inline-block !important;visibility:visible !important;opacity:1 !important;cursor:pointer;padding:6px 12px;border-radius:8px;border:1px solid #7c4dff;background:rgba(124,77,255,.15);color:inherit;font:inherit;font-size:.82rem;font-weight:600;white-space:nowrap;align-self:center}
    .sm-badge{display:inline-block;font-size:.62rem;letter-spacing:.06em;font-weight:700;padding:2px 7px;border-radius:999px;background:#7c4dff;color:#fff;vertical-align:middle}
    .sm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow:auto;z-index:9999}
    .sm-card{width:100%;max-width:440px;margin:auto;border-radius:14px;padding:18px 16px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
    .sm-card h3{margin:0 0 4px;font-size:1.05rem}
    .sm-card .sm-sub{opacity:.75;font-size:.85rem;margin:0 0 12px}
    .sm-leg{border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:10px;margin:10px 0}
    .sm-leg-t{font-weight:700;font-size:.82rem;margin-bottom:6px;opacity:.85}
    .sm-row{display:flex;gap:8px}
    .sm-row>*{flex:1;min-width:0}
    .sm-card input[type=text],.sm-card input[type=number],.sm-card input[type=date],.sm-card input[type=time],.sm-form input[type=number]{width:100%;box-sizing:border-box;padding:9px 10px;margin:3px 0 7px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:rgba(128,128,128,.10);color:inherit;font:inherit}
    .sm-lbl{display:block;font-size:.78rem;opacity:.8}
    .sm-actions{display:flex;gap:8px;margin-top:10px}
    .sm-actions button{flex:1}
    .sm-people{display:flex;flex-direction:column;gap:6px;margin:8px 0}
    .sm-people label,.sm-k{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid rgba(128,128,128,.4);border-radius:10px;cursor:pointer}
    .sm-form{margin:8px 0}
    .sm-ks{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin:8px 0}
    .sm-k.on{border-color:#7c4dff;background:rgba(124,77,255,.15)}
    .sm-preview{margin:8px 0;padding:10px 12px;border-radius:10px;background:rgba(128,128,128,.12);font-size:.88rem;line-height:1.5}
    .sm-warn{color:#e5484d;font-weight:700}
    .sm-leg-line{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:4px 0;border-top:1px dashed rgba(128,128,128,.3)}
    .sm-leg-line:first-child{border-top:none}
    .sm-res{display:flex;gap:4px;flex-wrap:wrap}
    .sm-res button{padding:5px 9px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;font-size:.78rem;cursor:pointer}
    .sm-res button.on-w{background:#2e9e5b;border-color:#2e9e5b;color:#fff}
    .sm-res button.on-l{background:#e5484d;border-color:#e5484d;color:#fff}
    .sm-res button.on-i{background:#888;border-color:#888;color:#fff}
    .sm-box{margin:10px 0;padding:10px 12px;border-radius:10px;background:rgba(128,128,128,.12);font-size:.88rem;line-height:1.55}
    .sm-box strong{font-weight:700}
  `;
  document.head.appendChild(st);
}

/* ---------- modal iskeleti ---------- */
function sistemModalKapat() {
  const ov = document.getElementById("sm-overlay");
  if (ov) ov.remove();
}
function sistemModalAc(html) {
  ensureSistemStyle();
  sistemModalKapat();
  let bg = "#fff", fg = "#111";
  try {
    const cs = getComputedStyle(document.body);
    if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) bg = cs.backgroundColor;
    if (cs.color) fg = cs.color;
  } catch (e) { /* varsayılan */ }
  const ov = document.createElement("div");
  ov.id = "sm-overlay";
  ov.className = "sm-overlay";
  ov.innerHTML = `<div class="sm-card" style="background:${bg};color:${fg}">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) sistemModalKapat(); });
  document.body.appendChild(ov);
  return ov;
}

/* ---------- yeni sistem kuponu ---------- */
function yeniSistemModal() {
  const ov = sistemModalAc(`
    <h3>Yeni Sistem Kuponu</h3>
    <p class="sm-sub">Katılacak kişileri seç. Herkes ${SISTEM_BACAK} maç girecek.</p>
    <div class="sm-people">
      ${USERS.map(u => `<label><input type="checkbox" value="${escapeHtml(u)}" checked> ${escapeHtml(u)}</label>`).join("")}
    </div>
    <div id="sm-err" class="sm-warn" style="display:none"></div>
    <div class="sm-actions">
      <button class="btn-secondary" id="sm-iptal">Vazgeç</button>
      <button class="btn-primary" id="sm-olustur">Oluştur</button>
    </div>
  `);
  ov.querySelector("#sm-iptal").addEventListener("click", sistemModalKapat);
  ov.querySelector("#sm-olustur").addEventListener("click", async () => {
    const secili = [...ov.querySelectorAll('.sm-people input:checked')].map(x => x.value);
    const err = ov.querySelector("#sm-err");
    if (secili.length < 2) { err.textContent = "En az 2 kişi seç."; err.style.display = "block"; return; }
    if (secili.length * SISTEM_BACAK > 12) { err.textContent = "En fazla 6 kişi."; err.style.display = "block"; return; }
    ov.querySelector("#sm-olustur").disabled = true;
    try { await sistemKuponOlustur(secili); sistemModalKapat(); }
    catch (e) { console.error(e); err.textContent = "Oluşturulamadı: " + (e.code || e.message); err.style.display = "block"; ov.querySelector("#sm-olustur").disabled = false; }
  });
}

async function sistemKuponOlustur(katilimcilar) {
  const now = new Date();
  const dateKey = dateKeyFor(now);
  const displayDate = displayDateFor(now);
  const snap = await getDocs(query(collection(db, "coupons"), where("dateKey", "==", dateKey)));
  let seq = snap.size + 1;
  let docId = seq === 1 ? dateKey : `${dateKey}-${seq}`;
  while ((await getDoc(doc(db, "coupons", docId))).exists()) {   // silinmiş kuponlardan kalan numara çakışması
    seq++; docId = `${dateKey}-${seq}`;
  }
  const displayName = seq === 1 ? displayDate : `${displayDate} (${seq})`;
  const matches = {}, results = {};
  katilimcilar.forEach(u => { matches[u] = null; results[u] = null; });
  await setDoc(doc(db, "coupons", docId), {
    tur: "sistem", bacak: SISTEM_BACAK,
    dateKey, seq, displayName,
    createdAt: serverTimestamp(), createdBy: currentUser,
    matches, results, legRes: {},
    sistem: { ks: [], stake: 0 },
    playedBy: null, playedAt: null
  });
  showToast(`${displayName} sistem kuponu açıldı`);
  openCoupon(docId);
}

/* ---------- maç girişi (kişi başı 2 maç) ---------- */
function sistemSlot(c, user, i) {
  const m = c.matches ? c.matches[user] : null;
  const isSelf = user === currentUser;
  const selfCanEdit = isSelf && !c.playedBy;
  const canEdit = isAdmin() || selfCanEdit;
  const slot = document.createElement("div");
  if (!m || !m.legs) {
    slot.className = `match-slot slot-empty ${isSelf ? "slot-self" : ""}`;
    slot.innerHTML = `
      <span class="slot-num">${i + 1}</span>
      <div class="slot-body">
        <div class="slot-player">${escapeHtml(user)}</div>
        <div class="slot-empty-label">${isSelf ? `${SISTEM_BACAK} maçını girmek için dokun →` : isAdmin() ? `Maçlar bekleniyor… (Admin: ${escapeHtml(user)} adına girebilirsin)` : "Maçlar bekleniyor…"}</div>
      </div>
      ${isAdmin() && !isSelf ? `<button type="button" class="sm-btn sm-fill">Doldur</button>` : ""}
    `;
    if (isSelf || isAdmin()) { slot.style.cursor = "pointer"; slot.addEventListener("click", () => sistemMacModal(c.id, user, null)); }
    const fb = slot.querySelector(".sm-fill");
    if (fb) fb.addEventListener("click", (e) => { e.stopPropagation(); sistemMacModal(c.id, user, null); });
    return slot;
  }
  slot.className = "match-slot";
  const lines = m.legs.map((l, idx) => {
    const r = (c.legRes && c.legRes[user] && c.legRes[user][idx]) || null;
    const badge = r === "tuttu" ? `<span class="slot-result status-won">Tuttu</span>`
      : r === "tutmadi" ? `<span class="slot-result status-lost">Tutmadı</span>`
      : r === "iptal" ? `<span class="slot-result">İptal</span>` : "";
    return `<div class="sm-leg-line">
        <div>
          <div class="slot-teams">${escapeHtml(l.teams)}</div>
          ${l.day || l.time ? `<div class="slot-time">🗓 ${escapeHtml(l.day || "")} ${escapeHtml(l.time || "")}</div>` : ""}
          <div class="slot-prediction">${escapeHtml(l.prediction)}</div>
        </div>
        <div style="text-align:right"><span class="slot-odds">${Number(l.odds).toFixed(2)}</span>${badge}</div>
      </div>`;
  }).join("");
  slot.innerHTML = `
    <span class="slot-num">${i + 1}</span>
    <div class="slot-body" style="flex:1">
      <div class="slot-player">${escapeHtml(user)}</div>
      ${lines}
    </div>
    ${canEdit ? `<button type="button" class="sm-btn sm-edit" title="Düzenle">✎ Düzenle</button>` : ""}
  `;
  if (canEdit) slot.querySelector(".sm-edit").addEventListener("click", (e) => { e.stopPropagation(); sistemMacModal(c.id, user, m); });
  return slot;
}

function sistemMacModal(couponId, user, mevcut) {
  const baslik = user === currentUser ? `${SISTEM_BACAK} maçını gir` : `${user} adına gir (Admin)`;
  const legBlok = (i) => {
    const l = (mevcut && mevcut.legs && mevcut.legs[i]) || {};
    return `
      <div class="sm-leg">
        <div class="sm-leg-t">${i + 1}. Maç</div>
        <label class="sm-lbl">Takımlar<input type="text" data-f="teams" data-i="${i}" value="${escapeHtml(l.teams || "")}" placeholder="Ev - Deplasman"></label>
        <div class="sm-row">
          <label class="sm-lbl">Gün<input type="date" data-f="dayIso" data-i="${i}" value="${escapeHtml(l.dayIso || "")}"></label>
          <label class="sm-lbl">Saat<input type="time" data-f="time" data-i="${i}" value="${escapeHtml(l.time || "")}"></label>
        </div>
        <div class="sm-row">
          <label class="sm-lbl">Tahmin<input type="text" data-f="prediction" data-i="${i}" value="${escapeHtml(l.prediction || "")}" placeholder="MS1, 2.5 Üst…"></label>
          <label class="sm-lbl">Oran<input type="number" step="0.01" min="1" inputmode="decimal" data-f="odds" data-i="${i}" value="${l.odds != null ? escapeHtml(String(l.odds)) : ""}"></label>
        </div>
      </div>`;
  };
  const ov = sistemModalAc(`
    <h3>${escapeHtml(baslik)}</h3>
    <p class="sm-sub">Sistem kuponu · tutar girmene gerek yok, oynayan kişi belirleyecek.</p>
    ${Array.from({ length: SISTEM_BACAK }, (_, i) => legBlok(i)).join("")}
    <div id="sm-err" class="sm-warn" style="display:none"></div>
    <div class="sm-actions">
      <button class="btn-secondary" id="sm-iptal">Vazgeç</button>
      <button class="btn-primary" id="sm-kaydet">Kaydet</button>
    </div>
  `);
  ov.querySelector("#sm-iptal").addEventListener("click", sistemModalKapat);
  ov.querySelector("#sm-kaydet").addEventListener("click", async () => {
    const err = ov.querySelector("#sm-err");
    const legs = [];
    for (let i = 0; i < SISTEM_BACAK; i++) {
      const g = (f) => ov.querySelector(`[data-f="${f}"][data-i="${i}"]`).value.trim();
      const odds = parseFloat(g("odds").replace(",", "."));
      const dayIso = g("dayIso");
      const teams = g("teams"), time = g("time"), prediction = g("prediction");
      if (!teams || !dayIso || !time || !prediction || !(odds > 1)) {
        err.textContent = `${i + 1}. maçta eksik ya da hatalı alan var (oran 1'den büyük olmalı).`;
        err.style.display = "block"; return;
      }
      const [y, mo, d] = dayIso.split("-");
      legs.push({ teams, dayIso, day: `${d}.${mo}.${y}`, time, prediction, odds });
    }
    const ozet = {
      legs,
      teams: legs.map(l => l.teams).join(" | "),
      prediction: legs.map(l => l.prediction).join(" | "),
      odds: legs.reduce((p, l) => p * l.odds, 1),
      amount: 0,
      enteredAt: serverTimestamp()
    };
    ov.querySelector("#sm-kaydet").disabled = true;
    try {
      await updateDoc(doc(db, "coupons", couponId), { [`matches.${user}`]: ozet });
      sistemModalKapat();
      showToast("Maçlar kaydedildi ✔");
    } catch (e) {
      console.error(e);
      err.textContent = "Kaydedilemedi: " + (e.code || e.message); err.style.display = "block";
      ov.querySelector("#sm-kaydet").disabled = false;
    }
  });
}

/* ---------- alt bölüm: sistem seçimi / sonuçlar ---------- */
function sistemOnizlemeHtml(c, harcanabilir) {
  const n = sistemBacaklar(c).length;
  const ks = [...sistemForm.ks].sort((a, b) => a - b);
  const kolon = ks.reduce((t, k) => t + comb(n, k), 0);
  const stake = parseFloat(String(sistemForm.stake).replace(",", ".")) || 0;
  if (!ks.length) return `Önce en az bir sistem seç.`;
  const unit = kolon ? stake / kolon : 0;
  const eAll = elemSym(sistemBacaklar(c).map(l => l.odds));
  const maxP = unit * ks.reduce((t, k) => t + (eAll[k] || 0), 0);
  let html = `<strong>${ks.join("+")}'lı sistem</strong> · ${kolon} kolon`;
  if (stake > 0) {
    html += `<br>Toplam tutar: <strong>${trTL(stake)}₺</strong> · kolon başı ≈ ${trTL(unit)}₺`;
    html += `<br>Hepsi tutarsa gelir: <strong>${trTL(maxP)}₺</strong>`;
    if (stake > harcanabilir + 0.005) html += `<br><span class="sm-warn">⚠ Kasada yeterli para yok (kasa: ${trTL(harcanabilir)}₺). Kupon oynanamaz.</span>`;
    else html += `<br>Kasada kalacak: ${trTL(harcanabilir - stake)}₺`;
  } else html += `<br>Toplam tutarı yaz.`;
  return html;
}

function sistemFormHtml(c, duzenle) {
  const n = sistemBacaklar(c).length;
  const kutular = [];
  for (let k = 2; k <= n; k++) {
    kutular.push(`<label class="sm-k ${sistemForm.ks.has(k) ? "on" : ""}"><input type="checkbox" data-k="${k}" ${sistemForm.ks.has(k) ? "checked" : ""}> ${k}'li <small style="opacity:.7">(${comb(n, k)} kolon)</small></label>`);
  }
  return `
    <div id="sm-form" class="sm-form">
      <p class="footer-note">${duzenle ? "Sistemi ya da toplam tutarı düzelt." : `Tüm maçlar girildi (${n} maç). Sistemi seç ve oynadığın toplam tutarı yaz. Para ortak kasadan çıkar.`}</p>
      <div class="sm-ks">${kutular.join("")}</div>
      <label class="sm-lbl">Toplam tutar (₺) — Nesine'de kuponun altında görünen toplam fiyat
        <input id="sm-stake" type="number" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(String(sistemForm.stake))}" placeholder="örn. 150">
      </label>
      <div id="sm-preview" class="sm-preview"></div>
      <div class="sm-actions">
        ${duzenle ? `<button class="btn-secondary" id="sm-vazgec">Vazgeç</button>` : ""}
        <button class="btn-primary" id="sm-oyna">${duzenle ? "Kaydet" : "🏦 Kuponu Oynadım (kasadan düş)"}</button>
      </div>
    </div>`;
}

function renderSistemFooter(c, info) {
  ensureSistemStyle();
  const footer = document.getElementById("ticket-footer");
  const duzenle = sistemForm.edit && sistemForm.couponId === c.id && !!c.playedBy;
  const formModu = info.key === "ready" || duzenle;
  const sig = c.id + "|" + info.key + "|" + (duzenle ? "e" : "");
  // Kullanıcı formu doldururken kasa/kupon güncellemesi gelirse yazdığını bozma
  if (formModu && footer.dataset.sig === sig && footer.querySelector("#sm-form") && footer.contains(document.activeElement)) {
    const pv = footer.querySelector("#sm-preview");
    if (pv) pv.innerHTML = sistemOnizlemeHtml(c, sistemHarcanabilir(c, duzenle));
    return;
  }
  footer.dataset.sig = sig;
  footer.innerHTML = "";

  if (info.key === "open") {
    footer.innerHTML = `<p class="footer-note">Herkes ${SISTEM_BACAK} maçını girdiğinde kupon hazır olacak. Sonra oynayan kişi sistemi ve tutarı seçecek.</p>`;
    return;
  }

  if (formModu) {
    if (sistemForm.couponId !== c.id || (!duzenle && info.key === "ready" && sistemForm.edit)) {
      sistemForm.couponId = c.id; sistemForm.ks = new Set(); sistemForm.stake = ""; sistemForm.edit = false;
    }
    if (duzenle && sistemForm.ks.size === 0) {
      sistemForm.ks = new Set(sistemHesap(c).ks);
      sistemForm.stake = String((c.sistem && c.sistem.stake) || "");
    }
    footer.innerHTML = sistemFormHtml(c, duzenle);
    const pv = footer.querySelector("#sm-preview");
    const guncelle = () => { pv.innerHTML = sistemOnizlemeHtml(c, sistemHarcanabilir(c, duzenle)); };
    guncelle();
    footer.querySelectorAll("input[data-k]").forEach(cb => cb.addEventListener("change", () => {
      const k = Number(cb.dataset.k);
      if (cb.checked) sistemForm.ks.add(k); else sistemForm.ks.delete(k);
      cb.closest(".sm-k").classList.toggle("on", cb.checked);
      guncelle();
    }));
    footer.querySelector("#sm-stake").addEventListener("input", (e) => { sistemForm.stake = e.target.value; guncelle(); });
    footer.querySelector("#sm-oyna").addEventListener("click", () => sistemOyna(c.id, duzenle));
    const vz = footer.querySelector("#sm-vazgec");
    if (vz) vz.addEventListener("click", () => { sistemForm.edit = false; sistemForm.ks = new Set(); renderSistemFooter(couponsCache.find(x => x.id === c.id) || c, info); });
    return;
  }

  // oynandı / sonuçlandı
  const h = sistemHesap(c);
  const canEditResults = isAdmin() || (c.playedBy === currentUser && !h.tamam);
  const final = info.key === "won" || info.key === "lost";
  let html = "";
  if (final) {
    const b = sistemBorclar(c);
    html += `<div class="final-banner ${info.key === "won" ? "won" : "lost"}">${info.key === "won" ? "🏆 Kupon Tuttu" : "Kupon Tutmadı"}</div>`;
    html += `<div class="sm-box">
      <div>Sistem: <strong>${h.ks.join("+")}</strong> · ${h.kolon} kolon · ${h.tutanKolon} kolon tuttu</div>
      <div>Yatırılan: <strong>${trTL(h.stake)}₺</strong> · Gelen: <strong>${trTL(h.payout)}₺</strong>${h.manuel !== null ? " <small>(elle girildi)</small>" : ""}</div>
      ${b.loss > 0.005 && b.totalFailed > 0 ? `<div class="sm-warn" style="margin-top:6px">Zarar: ${trTL(b.loss)}₺ — tutmayan maç sayısına göre paylaştırıldı:</div>` +
        Object.keys(b.perUser).map(u => `<div>• ${escapeHtml(u)}: ${b.perUser[u].failedLegs.length}/${b.totalFailed} maç → <strong>${trTL(b.perUser[u].debt)}₺</strong> borç</div>`).join("") : ""}
      ${h.payout - h.stake > 0.005 ? `<div style="margin-top:6px">Kâr: <strong>${trTL(h.payout - h.stake)}₺</strong></div>` : ""}
    </div>`;
  } else {
    html += `<p class="footer-note">Kuponu <strong>${escapeHtml(c.playedBy)}</strong> oynattı: <strong>${h.ks.join("+")}</strong> sistem, ${h.kolon} kolon, ${trTL(h.stake)}₺ (kasadan). Hepsi tutarsa ${trTL(h.maxPayout)}₺. Maçlar bitince sonuçları işaretle:</p>`;
  }
  footer.innerHTML = html;

  // kazanç aksiyonu
  if (final && h.payout > 0.005 && !c.payoutAction) {
    if (canEditResults || c.playedBy === currentUser) {
      const row = document.createElement("div");
      row.className = "fund-choice-row";
      if (info.key === "won") {
        footer.insertAdjacentHTML("beforeend", `<p class="footer-note">Gelen <strong>${trTL(h.payout)}₺</strong> ne oldu?</p>`);
        row.innerHTML = `<button id="payout-distribute-btn" class="btn-primary">💸 Kişilere Dağıtıldı</button><button id="payout-pool-btn" class="btn-secondary">🏦 Havuza Aktar</button>`;
      } else {
        footer.insertAdjacentHTML("beforeend", `<p class="footer-note">Kupon zararda bitti ama <strong>${trTL(h.payout)}₺</strong> geri geldi. Kasaya eklensin:</p>`);
        row.innerHTML = `<button id="payout-pool-btn" class="btn-primary">🏦 ${trTL(h.payout)}₺ Havuza Aktar</button>`;
      }
      footer.appendChild(row);
      const d = row.querySelector("#payout-distribute-btn");
      if (d) d.addEventListener("click", () => setPayoutAction(c, "distributed"));
      row.querySelector("#payout-pool-btn").addEventListener("click", () => setPayoutAction(c, "pooled"));
    }
  } else if (final && c.payoutAction) {
    const label = c.payoutAction === "pooled" ? "Havuza eklendi" : "Kişilere dağıtıldı";
    footer.insertAdjacentHTML("beforeend", `<p class="footer-note payout-done">Gelen kazanç: <strong>${label}</strong></p>`);
  }

  // sonuç satırları
  if (canEditResults) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<p class="footer-note">${final ? "Admin olarak sonuçları değiştirebilirsin:" : ""}</p>`;
    h.legs.forEach(l => {
      const row = document.createElement("div");
      row.className = "result-row";
      row.innerHTML = `
        <span class="result-teams">${escapeHtml(l.user)}: ${escapeHtml(l.teams)} <small style="opacity:.7">(${escapeHtml(String(l.prediction))} · ${Number(l.odds).toFixed(2)})</small></span>
        <span class="sm-res">
          <button data-u="${escapeHtml(l.user)}" data-i="${l.i}" data-v="tuttu" class="${l.res === "tuttu" ? "on-w" : ""}">Tuttu</button>
          <button data-u="${escapeHtml(l.user)}" data-i="${l.i}" data-v="tutmadi" class="${l.res === "tutmadi" ? "on-l" : ""}">Tutmadı</button>
          <button data-u="${escapeHtml(l.user)}" data-i="${l.i}" data-v="iptal" class="${l.res === "iptal" ? "on-i" : ""}" title="Maç iptal / iade — oranı 1 sayılır">İptal</button>
        </span>`;
      wrap.appendChild(row);
    });
    footer.appendChild(wrap);
    wrap.querySelectorAll(".sm-res button").forEach(btn => {
      btn.addEventListener("click", () => sistemSonuc(c.id, btn.dataset.u, Number(btn.dataset.i), btn.dataset.v));
    });
  } else if (!final) {
    footer.insertAdjacentHTML("beforeend", `<p class="footer-note">Sonuçları oynatan kişi (ya da admin) işaretleyecek.</p>`);
  }

  // admin araçları
  if (isAdmin() || c.playedBy === currentUser) {
    const tools = document.createElement("div");
    tools.className = "fund-edit-row";
    tools.innerHTML = `
      ${isAdmin() && !c.payoutAction ? `<button class="fund-edit-btn" id="sm-duzelt">✎ Sistem / tutarı düzelt</button>` : ""}
      ${h.tamam && !c.payoutAction ? `<button class="fund-edit-btn" id="sm-elle">💰 Gelen kazancı elle gir</button>` : ""}`;
    if (tools.querySelector("button")) footer.appendChild(tools);
    const dz = tools.querySelector("#sm-duzelt");
    if (dz) dz.addEventListener("click", () => {
      sistemForm.couponId = c.id; sistemForm.edit = true; sistemForm.ks = new Set(); sistemForm.stake = "";
      renderSistemFooter(couponsCache.find(x => x.id === c.id) || c, couponStatusInfo(c));
    });
    const el = tools.querySelector("#sm-elle");
    if (el) el.addEventListener("click", () => sistemKazancElle(c.id));
  }
}

function sistemHarcanabilir(c, duzenle) {
  return poolBalance + (duzenle ? Number(c.sistem && c.sistem.stake) || 0 : 0);
}

async function sistemOyna(couponId, duzenle) {
  const c = couponsCache.find(x => x.id === couponId);
  if (!c) return;
  const n = sistemBacaklar(c).length;
  const ks = [...sistemForm.ks].filter(k => k >= 2 && k <= n).sort((a, b) => a - b);
  const stake = Math.round((parseFloat(String(sistemForm.stake).replace(",", ".")) || 0) * 100) / 100;
  if (!ks.length) { showToast("En az bir sistem seç"); return; }
  if (!(stake > 0)) { showToast("Toplam tutarı yaz"); return; }
  const eski = duzenle ? Number(c.sistem && c.sistem.stake) || 0 : 0;
  const fark = stake - eski;
  if (fark > 0 && poolBalance + 0.005 < fark) {
    showToast(`Kasada yeterli para yok (kasa: ${poolBalance.toFixed(0)}₺, gerekli: ${fark.toFixed(0)}₺). Kupon oynanamaz.`);
    return;
  }
  const kolon = ks.reduce((t, k) => t + comb(n, k), 0);
  let kasaDustu = false;
  try {
    if (Math.abs(fark) > 0.0001) { await updateDoc(poolRef, { balance: increment(-fark) }); kasaDustu = true; }
    const upd = { "sistem.ks": ks, "sistem.stake": stake, "sistem.kolon": kolon };
    if (!duzenle) { upd.playedBy = currentUser; upd.playedAt = serverTimestamp(); upd.fundingSource = "pool"; }
    await updateDoc(doc(db, "coupons", couponId), upd);
    sistemForm.edit = false; sistemForm.ks = new Set(); sistemForm.stake = "";
    showToast(duzenle ? "Sistem güncellendi ✔" : `Kupon oynatıldı (kasadan -${stake.toFixed(0)}₺)`);
  } catch (err) {
    console.error(err);
    if (kasaDustu) { try { await updateDoc(poolRef, { balance: increment(fark) }); } catch (e2) { console.error(e2); } }
    showToast("Kaydedilemedi: " + (err.code || err.message));
  }
}

async function sistemSonuc(couponId, user, i, val) {
  const c = couponsCache.find(x => x.id === couponId);
  if (!c || !c.matches || !c.matches[user]) return;
  const m = c.matches[user];
  const cur = (c.legRes && c.legRes[user]) ? c.legRes[user].slice() : [];
  while (cur.length < m.legs.length) cur.push(null);
  cur[i] = cur[i] === val ? null : val;
  const kayip = cur.some(x => x === "tutmadi");
  const hepsi = cur.every(x => x === "tuttu" || x === "iptal");
  const r = kayip ? "tutmadi" : (hepsi ? "tuttu" : null);
  try {
    await updateDoc(doc(db, "coupons", couponId), { [`legRes.${user}`]: cur, [`results.${user}`]: r });
  } catch (err) { console.error(err); showToast("Kaydedilemedi: " + (err.code || err.message)); }
}

async function sistemKazancElle(couponId) {
  const c = couponsCache.find(x => x.id === couponId);
  if (!c) return;
  const h = sistemHesap(c);
  const v = window.prompt(`Nesine'de görünen gerçek gelen tutarı yaz (₺).\nSitenin hesabı: ${trTL(h.hesap)}₺\nBoş bırakıp Tamam'a basarsan elle girilen tutar silinir.`, h.manuel !== null ? String(h.manuel) : "");
  if (v === null) return;
  const t = v.trim();
  let val = null;
  if (t !== "") {
    val = parseFloat(t.replace(",", "."));
    if (isNaN(val) || val < 0) { showToast("Geçersiz tutar"); return; }
  }
  try { await updateDoc(doc(db, "coupons", couponId), { "sistem.odenenKazanc": val }); showToast("Güncellendi ✔"); }
  catch (err) { console.error(err); showToast("Kaydedilemedi: " + (err.code || err.message)); }
}

/* ---------- ana sayfada "Yeni Sistem Kuponu" düğmesi ---------- */
(function sistemDugmesiEkle() {
  const eski = document.getElementById("new-coupon-btn");
  if (!eski || document.getElementById("new-sistem-btn")) return;
  ensureSistemStyle();
  const b = document.createElement("button");
  b.id = "new-sistem-btn";
  b.className = eski.className;
  b.type = "button";
  b.textContent = "+ Sistem Kuponu";
  b.style.marginLeft = "8px";
  b.addEventListener("click", yeniSistemModal);
  eski.insertAdjacentElement("afterend", b);
})();

/* ============================================================
   BOOT
   ============================================================ */
async function boot() {
  await authReady;
  // Pasif edilmiş bir kullanıcı daha önce giriş yapmış ve tarayıcısında
  // oturumu kayıtlıysa, otomatik olarak çıkış yaptır.
  if (currentUser && !USERS.includes(currentUser)) {
    currentUser = null;
    localStorage.removeItem("kupon_user");
  }
  renderNameGrid();
  renderRules();
  if (currentUser) {
    enterApp();
  }
}
boot();
