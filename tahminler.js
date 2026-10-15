// Nesine bülteni + API-Football birleştirme (Maçlar sekmesi) ve AI Tahminler sekmesi.
//
// - MAÇLAR sekmesi: Nesine'deki TÜM futbol maçları ve oranları listelenir. Takip ettiğimiz
//   liglerden API-Football verisi olan maçlara canlı skor ve "İstatistik" paneli eklenir.
//   Nesine verisi yoksa eski liste (liveMatches) aynen gösterilir.
// - TAHMİNLER sekmesi: sadece AI'nın kuponları ve kendi istatistiği.
//
// index.html'e tek satır eklenir: <script type="module" src="tahminler.js"></script>
// app.js'e dokunulmaz.

import { db, authReady } from "./firebase-config.js";
import {
  doc, onSnapshot, collection, query, orderBy, limit, addDoc, serverTimestamp, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SANAL_BAHIS = 100;          // AI kuponları için varsayımsal sabit tutar (₺)
const TZ = "Europe/Istanbul";
const BAYAT_SAAT = 26;            // bülten bundan eskiyse uyarı göster
const ZAMAN_TOLERANS_DK = 25;     // iki kaynakta maç saati bu kadar farklı olabilir
const CANLI = ["1H", "2H", "HT", "ET", "P", "LIVE"];
const BITMIS = ["FT", "AET", "PEN"];

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dayKey = (offset = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + offset * 864e5));
const hm = d => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const nowHM = () => hm(new Date());
const dk = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
const fmtOdd = o => (o == null ? "–" : Number(o).toFixed(2));
const fmtTime = iso => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : new Intl.DateTimeFormat("tr-TR", {
    timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(d);
};
const TR_DATE = k => k.split("-").reverse().join(".");

/* ================= Takım adı eşleştirme ================= */
const STOP = new Set(["fc", "sk", "fk", "cf", "afc", "bk", "if", "sc", "ac", "as", "us", "cd", "ud", "club", "de", "the", "ssc", "sv", "vfb", "vfl", "tsv", "kf", "nk", "hnk", "cfr"]);
const ESLE = { utd: "united", intl: "international", psg: "paris saint germain", man: "manchester", atl: "atletico" };

export function normalize(s) {
  return String(s ?? "").toLocaleLowerCase("en").replace(/ı/g, "i")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .map(t => ESLE[t] || t).filter(t => t && !STOP.has(t)).join(" ");
}
function bigram(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
export function benzerlik(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigram(a), B = bigram(b);
  let ortak = 0, na = 0, nb = 0;
  A.forEach((v, g) => { na += v; if (B.has(g)) ortak += Math.min(v, B.get(g)); });
  B.forEach(v => { nb += v; });
  let d = na + nb ? (2 * ortak) / (na + nb) : 0;
  const kisa = Math.min(a.length, b.length);
  if (kisa >= 4 && (a.includes(b) || b.includes(a))) d = Math.max(d, 0.85);
  return d;
}

// Nesine maçları (n) ile API-Football maçlarını (api) eşleştirir: Map(nesine.id -> api maçı)
export function esle(nesine, api) {
  const adaylar = [];
  nesine.forEach((n, i) => {
    api.forEach((a, j) => {
      const d = new Date(a.date);
      if (isNaN(d)) return;
      if (Math.abs(dk(hm(d)) - dk(n.t)) > ZAMAN_TOLERANS_DK) return;
      const h = benzerlik(n.h, a.home), v = benzerlik(n.a, a.away);
      if (Math.min(h, v) < 0.4 || (h + v) / 2 < 0.55) return;
      adaylar.push({ i, j, skor: (h + v) / 2 });
    });
  });
  adaylar.sort((x, y) => y.skor - x.skor);
  const kullN = new Set(), kullA = new Set(), sonuc = new Map();
  adaylar.forEach(c => {
    if (kullN.has(c.i) || kullA.has(c.j)) return;
    kullN.add(c.i); kullA.add(c.j);
    sonuc.set(nesine[c.i].id, api[c.j]);
  });
  return sonuc;
}

/* ================= Pazar tanımları ================= */
const ANA = [
  { k: "ms", baslik: "MS", etiket: ["1", "X", "2"] },
  { k: "au25", baslik: "2,5 A/Ü", etiket: ["Alt", "Üst"] }
];
const EK = [
  { k: "cs", baslik: "Çifte Şans", etiket: ["1X", "12", "X2"] },
  { k: "kg", baslik: "KG", etiket: ["Var", "Yok"] },
  { k: "au15", baslik: "1,5 A/Ü", etiket: ["Alt", "Üst"] },
  { k: "au35", baslik: "3,5 A/Ü", etiket: ["Alt", "Üst"] },
  { k: "tga", baslik: "Toplam Gol", etiket: ["0-1", "2-3", "4-5", "6+"] },
  { k: "iyms", baslik: "İY/MS", etiket: ["1/1", "1/X", "1/2", "X/1", "X/X", "X/2", "2/1", "2/X", "2/2"] }
];

/* ================= Durum ================= */
const state = { ara: "", gizle: true, acik: new Set(), stat: new Set(), aiGun: null };
const bulten = {};        // tarih -> { maclar, guncelleme, adet }
const apiGun = {};        // tarih -> liveMatches maçları
let durum = null;         // bulten/status
let aiKuponlar = [];
let aiDurum = null;       // bulten/aiStatus
let tahminRoot = null;
let analizler = [];       // analizler (Maç analizi sohbeti)
let sohbetBasladi = false;
let maclar = null;        // { view, orig, note, liste, durumEl }
let basladi = false;

/* ================= MAÇLAR sekmesi ================= */
function mountMaclar() {
  const view = document.getElementById("view-matches");
  if (!view) return false;
  if (view.querySelector("#thm-liste")) return true;
  const orig = view.querySelector("#matches-list");
  const tabs = view.querySelector(".matches-day-tabs");
  if (!orig || !tabs) return false;
  const note = view.querySelector(".matches-note");

  const tools = document.createElement("div");
  tools.className = "thm-tools";
  tools.innerHTML = `
    <input id="thm-ara" class="thm-ara" type="search" placeholder="Takım veya lig ara" autocomplete="off">
    <label class="thm-chk"><input id="thm-gizle" type="checkbox" checked> Başlayanları gizle</label>`;
  const durumEl = document.createElement("div");
  durumEl.id = "thm-durum";
  durumEl.className = "thm-durum";
  const liste = document.createElement("div");
  liste.id = "thm-liste";
  liste.className = "thm-liste";

  tabs.insertAdjacentElement("afterend", tools);
  tools.insertAdjacentElement("afterend", durumEl);
  orig.insertAdjacentElement("afterend", liste);
  maclar = { view, orig, note, liste, durumEl };

  tools.querySelector("#thm-ara").addEventListener("input", e => { state.ara = e.target.value.trim().toLocaleLowerCase("tr"); renderMaclar(); });
  tools.querySelector("#thm-gizle").addEventListener("change", e => { state.gizle = e.target.checked; renderMaclar(); });
  tabs.addEventListener("click", () => setTimeout(renderMaclar, 0));
  liste.addEventListener("click", e => {
    const more = e.target.closest("[data-thm-more]");
    if (more) { toggle(state.acik, more.dataset.thmMore); return renderMaclar(); }
    const st = e.target.closest("[data-thm-stat]");
    if (st) { toggle(state.stat, st.dataset.thmStat); renderMaclar(); }
  });

  // Eski liste (istatistik panelleri) yeniden çizilince biz de yenileriz
  let t;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(renderMaclar, 120); })
    .observe(orig, { childList: true, subtree: true });
  return true;
}
const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));

function aktifGun() {
  const b = maclar && maclar.view.querySelector(".matches-day-tabs .filter-btn.active");
  return b && b.dataset.day === "tomorrow" ? 1 : 0;
}

function oranHucreleri(def, dizi) {
  return def.etiket.map((et, i) =>
    `<span class="thm-o"><i>${esc(et)}</i><b>${fmtOdd(dizi && dizi[i])}</b></span>`).join("");
}
function statPaneli(api) {
  if (!api || !api.stats) return "";
  const el = document.getElementById("stats-" + api.fixtureId);
  if (!el) return "";
  const c = el.cloneNode(true);
  c.removeAttribute("id");
  c.classList.remove("hidden");
  return c.outerHTML;
}
function zamanHucresi(m, api) {
  if (api && CANLI.includes(api.status)) return { text: api.elapsed ? `${api.elapsed}'` : "CANLI", canli: true };
  if (api && BITMIS.includes(api.status)) return { text: "MS", canli: false };
  return { text: m.t, canli: false };
}

function macSatiri(m, api) {
  const id = String(m.id);
  const acik = state.acik.has(id);
  const z = zamanHucresi(m, api);
  const skorVar = api && api.goalsHome != null && api.goalsAway != null;
  const panel = statPaneli(api);
  const statAcik = state.stat.has(id) && panel;
  const ana = ANA.map(def => `<span class="thm-grp"><em>${esc(def.baslik)}</em>${oranHucreleri(def, m.m && m.m[def.k])}</span>`).join("");
  const ek = acik ? `<div class="thm-ek">${EK.filter(def => m.m && m.m[def.k]).map(def =>
    `<span class="thm-grp"><em>${esc(def.baslik)}</em>${oranHucreleri(def, m.m[def.k])}</span>`).join("") || "<span class='thm-bos'>Ek oran yok</span>"}</div>` : "";
  return `<div class="thm-row">
    <div class="thm-time ${z.canli ? "canli" : ""}">${esc(z.text)}</div>
    <div class="thm-teams"><b>${esc(m.h)}</b><span>${esc(m.a)}</span>${m.mbs > 1 ? `<small class="thm-mbs" title="Bu maç için minimum seçim sayısı">MBS ${esc(m.mbs)}</small>` : ""}</div>
    <div class="thm-odds">${skorVar ? `<span class="thm-score">${esc(api.goalsHome)} - ${esc(api.goalsAway)}</span>` : ""}${ana}</div>
    <div class="thm-act">
      ${panel ? `<button class="match-detail-toggle" type="button" data-thm-stat="${esc(id)}">İstatistik ${statAcik ? "▴" : "▾"}</button>` : ""}
      <button class="thm-more" type="button" data-thm-more="${esc(id)}" aria-expanded="${acik}" title="Diğer oranlar">${acik ? "−" : "+"}</button>
    </div>
    ${ek}
    ${statAcik ? `<div class="thm-statwrap">${panel}</div>` : ""}
  </div>`;
}

function renderMaclar() {
  if (!maclar) return;
  const { orig, note, liste, durumEl } = maclar;
  const key = dayKey(aktifGun());
  const veri = bulten[key];

  // Nesine verisi yoksa eski liste görünür kalır
  orig.style.display = veri ? "none" : "";
  if (note) note.style.display = veri ? "none" : "";
  liste.style.display = veri ? "" : "none";

  let not = "Oranlar Nesine bülteninden her sabah 08:00'de alınır; gün içinde değişebilir, <b>kupon yapmadan önce Nesine'de kontrol edin</b>.";
  let sinif = "";
  if (veri) {
    const yas = (Date.now() - new Date(veri.guncelleme).getTime()) / 36e5;
    not = `Nesine bülteni: <b>${fmtTime(veri.guncelleme)}</b> · ${veri.adet} maç. ` + not;
    if (yas > BAYAT_SAAT) { sinif = "uyari"; not = `⚠️ Veri ${Math.round(yas)} saatten eski. ` + not; }
  } else {
    sinif = "uyari";
    not = `⚠️ ${TR_DATE(key)} için Nesine bülteni henüz alınmadı, aşağıda sadece takip edilen liglerin eski listesi var.`;
  }
  if (durum && durum.ok === false) {
    sinif = "uyari";
    not = `⚠️ Son çekim başarısız (${fmtTime(durum.lastRun)}): ${esc(durum.message || "bilinmeyen hata")}. ` + not;
  }
  durumEl.className = "thm-durum " + sinif;
  durumEl.innerHTML = not;
  if (!veri) return;

  const apiListe = apiGun[key] || [];
  const eslesen = esle(veri.maclar, apiListe);
  const simdi = nowHM();
  const bugunMu = key === dayKey(0);
  const gorunen = veri.maclar.filter(m => {
    const api = eslesen.get(m.id);
    if (state.gizle && bugunMu) {
      if (api && CANLI.includes(api.status)) { /* canlı maç kalsın */ }
      else if (m.t < simdi || (api && BITMIS.includes(api.status))) return false;
    }
    if (state.ara) return (`${m.h} ${m.a} ${m.lg}`).toLocaleLowerCase("tr").includes(state.ara);
    return true;
  });
  if (!gorunen.length) { liste.innerHTML = `<p class="thm-bos">Bu filtreyle maç bulunamadı.</p>`; return; }

  const gruplar = new Map();
  gorunen.forEach(m => { if (!gruplar.has(m.lg)) gruplar.set(m.lg, []); gruplar.get(m.lg).push(m); });
  const sirali = [...gruplar.entries()].sort((a, b) => a[1][0].t.localeCompare(b[1][0].t) || a[0].localeCompare(b[0], "tr"));
  const istatli = gorunen.filter(m => { const a = eslesen.get(m.id); return a && a.stats; }).length;
  liste.innerHTML = `<p class="thm-say">${gorunen.length} maç · ${sirali.length} lig · ${istatli} maçta istatistik var</p>` +
    sirali.map(([lg, ms]) => `<div class="thm-lig"><h4>${esc(lg)}</h4>${ms.map(m => macSatiri(m, eslesen.get(m.id))).join("")}</div>`).join("");
}

/* ================= TAHMİNLER sekmesi (sadece AI) ================= */
function mountTahminler() {
  const matchesView = document.getElementById("view-matches");
  const navMatches = document.querySelector('.nav-btn[data-view="matches"]');
  if (document.getElementById("view-tahminler")) return true;
  if (!matchesView || !navMatches) return false;

  if (!document.querySelector('link[href*="tahminler.css"]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("tahminler.css", import.meta.url).href;
    document.head.appendChild(css);
  }

  const btn = document.createElement("button");
  btn.className = "nav-btn";
  btn.dataset.view = "tahminler";
  btn.textContent = "Tahminler";
  navMatches.insertAdjacentElement("afterend", btn);
  btn.hidden = true; // sadece admin (Nihat) görür; aşağıdaki yoklama açar/kapatır

  tahminRoot = document.createElement("main");
  tahminRoot.id = "view-tahminler";
  tahminRoot.className = "view view-tahminler";
  tahminRoot.innerHTML = `
    <div class="thm-head">
      <h2 class="section-title">AI Tahminler</h2>
      <p class="section-sub">AI'nın her gün kendi seçtiği kuponlar. AI bunları kendisi oynamış gibi kaydeder, sonuçları ve başarısı sizin kuponlarınızdan ayrı tutulur. Günün tüm maçları ve oranları <b>Maçlar</b> sekmesinde.</p>
    </div>
    <div id="thm-ai"></div>
    <section class="thm-chat" id="thm-chat">
      <h3 class="thm-chat-baslik">💬 Maç analizi</h3>
      <p class="thm-chat-alt">Bir maç yaz, son maçlar, puan durumu, sakatlıklar ve internet araştırmasıyla analiz edeyim. Maç dışındaki mesajlara cevap vermem.</p>
      <div class="thm-modlar" id="thm-modlar" role="radiogroup" aria-label="Analiz türü">
        <button type="button" class="thm-mod" data-mod="prompt" title="Veriyi ben toplarım, sen Claude.ai/ChatGPT'ye yapıştırırsın. Ücretsiz.">📋 Prompt hazırla <small>ücretsiz</small></button>
        <button type="button" class="thm-mod" data-mod="gemini" title="Gemini ücretsiz API + Google araması. Cevap burada çıkar.">🔎 Gemini <small>ücretsiz</small></button>
        <button type="button" class="thm-mod" data-mod="claude" title="Claude + internet araması. API kredisi harcar.">✨ Claude <small>ücretli</small></button>
      </div>
      <form id="thm-chat-form" class="thm-chat-form" autocomplete="off">
        <input id="thm-chat-in" class="thm-ara" type="text" maxlength="300" placeholder="Takım – Takım (örn. Antalyaspor – Kayserispor)">
        <button id="thm-chat-btn" class="thm-chat-btn" type="submit">Analiz et</button>
      </form>
      <p id="thm-chat-not" class="thm-chat-not" hidden></p>
      <div id="thm-chat-list" class="thm-chat-list"></div>
      <details class="thm-gh">
        <summary>⚙ GitHub bağlantısı (analizi anında başlatmak için)</summary>
        <p>Analiz GitHub'da çalışır. Anında başlaması için GitHub'da <b>sadece bu repo</b> ve <b>Actions: Read and write</b> izni olan bir "fine-grained token" oluşturup buraya yapıştır. Anahtar yalnızca bu tarayıcıda saklanır; siteye veya veritabanına yazılmaz. Anahtar girmezsen soru kaydedilir ve en geç birkaç saat içinde yedek çalışma işler.</p>
        <div class="thm-gh-satir"><input id="thm-gh-in" class="thm-ara" type="password" placeholder="github_pat_..." autocomplete="off"><button id="thm-gh-kaydet" type="button" class="thm-chat-btn">Kaydet</button><button id="thm-gh-sil" type="button" class="thm-chat-btn thm-ikincil">Sil</button></div>
        <p id="thm-gh-durum" class="thm-chat-not"></p>
      </details>
    </section>`;
  matchesView.insertAdjacentElement("afterend", tahminRoot);

  btn.addEventListener("click", () => {
    document.querySelectorAll(".app-shell .view").forEach(v => v.classList.remove("active"));
    tahminRoot.classList.add("active");
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b === btn));
    renderAI();
  });
  tahminRoot.addEventListener("click", e => {
    const g = e.target.closest("[data-thm-aigun]");
    if (g) { state.aiGun = g.dataset.thmAigun; renderAI(); }
    const sl = e.target.closest("[data-thm-sil]");
    if (sl) { analizSil(sl.dataset.thmSil); return; }
    const tm = e.target.closest("[data-thm-temizle]");
    if (tm) { tumunuSil(); return; }
    const ac = e.target.closest("[data-thm-ac]");
    if (ac) { itemAcKapa(ac.dataset.thmAc); return; }
    const tk = e.target.closest("[data-thm-tekrar]");
    if (tk) sor(tk.dataset.thmTekrar, tk.dataset.thmMod);
    const kp = e.target.closest("[data-thm-kopya]");
    if (kp) {
      const ta = kp.closest(".thm-item-govde").querySelector("textarea");
      if (ta) kopyala(ta, kp);
    }
    const md = e.target.closest("[data-mod]");
    if (md) { MOD = md.dataset.mod; try { localStorage.setItem("thm_mod", MOD); } catch { /* */ } modGoster(); }
  });
  tahminRoot.querySelector("#thm-chat-form").addEventListener("submit", e => {
    e.preventDefault();
    const inp = tahminRoot.querySelector("#thm-chat-in");
    const m = inp.value.trim();
    if (m) { inp.value = ""; sor(m, MOD); }
  });
  modGoster();
  const ghDurum = () => {
    const el = tahminRoot.querySelector("#thm-gh-durum");
    el.textContent = ghAnahtar() ? "✔ Anahtar kayıtlı (bu tarayıcıda)." : "Anahtar yok.";
  };
  tahminRoot.querySelector("#thm-gh-kaydet").addEventListener("click", () => {
    const i = tahminRoot.querySelector("#thm-gh-in");
    const v = i.value.trim();
    if (v) { try { localStorage.setItem(GH_ANAHTAR, v); } catch { /* özel pencere */ } i.value = ""; }
    ghDurum();
  });
  tahminRoot.querySelector("#thm-gh-sil").addEventListener("click", () => { try { localStorage.removeItem(GH_ANAHTAR); } catch { /* */ } ghDurum(); });
  ghDurum();
  return true;
}

/* Tahminler sekmesi yalnızca admin'e (Nihat) görünür. Giriş/çıkış app.js'te
   localStorage "kupon_user" üzerinden yapıldığı için her saniye yoklanır. */
const ADMIN_ADI = "Nihat";
function adminMi() { try { return localStorage.getItem("kupon_user") === ADMIN_ADI; } catch { return false; } }
function sekmeGorunurluk() {
  const btn = document.querySelector('.nav-btn[data-view="tahminler"]');
  if (!btn) return;
  const izinli = adminMi();
  btn.hidden = !izinli;
  if (izinli) { sohbetBaslat(); otoTetik(); }
  btn.style.display = izinli ? "" : "none";
  if (!izinli && tahminRoot && tahminRoot.classList.contains("active")) {
    tahminRoot.classList.remove("active");
    const home = document.querySelector('.nav-btn[data-view="home"]');
    if (home) home.click();
  }
}
setInterval(sekmeGorunurluk, 1000);

/* ================= MAÇ ANALİZİ sohbeti (sadece admin) ================= */
const GH_REPO = "nihatcagdas-byte/ortak_kupon";
const GH_WORKFLOW = "mac-analiz.yml";
const GH_ANAHTAR = "thm_gh_token";
const TAKILDI_DK = 8;
const ghAnahtar = () => { try { return localStorage.getItem(GH_ANAHTAR) || ""; } catch { return ""; } };

let MOD = (() => { try { const v = localStorage.getItem("thm_mod"); return ["prompt", "gemini", "claude"].includes(v) ? v : "prompt"; } catch { return "prompt"; } })();
const MOD_ETIKET = { prompt: "Prompt", gemini: "Gemini", claude: "Claude" };
function modGoster() {
  if (!tahminRoot) return;
  tahminRoot.querySelectorAll(".thm-mod").forEach(b => { b.classList.toggle("aktif", b.dataset.mod === MOD); b.setAttribute("aria-pressed", String(b.dataset.mod === MOD)); });
}
async function kopyala(ta, btn) {
  try { await navigator.clipboard.writeText(ta.value); }
  catch { ta.select(); try { document.execCommand("copy"); } catch { /* */ } }
  const eski = btn.textContent;
  btn.textContent = "✔ Kopyalandı";
  setTimeout(() => { btn.textContent = eski; }, 1800);
}

function chatNot(metin) {
  const el = tahminRoot && tahminRoot.querySelector("#thm-chat-not");
  if (!el) return;
  el.textContent = metin || "";
  el.hidden = !metin;
}

// GitHub Actions iş akışını başlatır. Dönüş: "ok" | "yetki" | "yok" | "ag" | "hata"
async function ghDispatch(workflow, inputs) {
  const tok = ghAnahtar();
  if (!tok) return "anahtar-yok";
  let bulunamadi = false;
  for (const ref of ["main", "master"]) {
    try {
      const res = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        headers: { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ ref, inputs })
      });
      if (res.status === 204) return "ok";
      if (res.status === 401 || res.status === 403) return "yetki";
      if (res.status === 404) { bulunamadi = true; continue; } // dal adı farklı olabilir (main/master)
    } catch { return "ag"; }
  }
  return bulunamadi ? "yok" : "hata";
}

async function tetikle(id) {
  const s = await ghDispatch(GH_WORKFLOW, { id });
  const NOT = {
    ok: "",
    "anahtar-yok": "Soru kaydedildi. GitHub anahtarı girilmediği için analiz anında başlamaz; yedek çalışma en geç birkaç saat içinde işler. (Aşağıdaki ⚙ bölümünden anahtar ekleyebilirsin.)",
    yetki: "GitHub anahtarı reddedildi (süresi dolmuş veya izin eksik). Soru kaydedildi; yedek çalışma işler.",
    ag: "GitHub'a ulaşılamadı. Soru kaydedildi; yedek çalışma işler.",
    yok: "GitHub'da mac-analiz.yml bulunamadı veya anahtarın bu repoya erişimi yok. Soru kaydedildi; yedek çalışma işler.",
    hata: "Analiz başlatılamadı (GitHub). Soru kaydedildi; yedek çalışma işler."
  };
  chatNot(NOT[s]);
}

/* Günlük kuponlar için güvence: GitHub'ın zamanlayıcısı saatlerce gecikebiliyor.
   Nihat siteyi açtığında bugünün kuponları 08:30'dan sonra hâlâ yoksa iş akışı kendiliğinden başlatılır
   (en fazla 30 dakikada bir; GitHub anahtarı girilmişse). */
const OTO_ANAHTAR = "thm_oto_son";
let aiYuklendi = false, otoDeneme = false;
async function otoTetik() {
  if (otoDeneme || !aiYuklendi || !adminMi() || !ghAnahtar()) return;
  if (aiKuponlar.some(k => k.dateKey === dayKey(0))) return;
  if (dk(nowHM()) < 8 * 60 + 30) return;
  let son = 0;
  try { son = Number(localStorage.getItem(OTO_ANAHTAR)) || 0; } catch { /* */ }
  if (Date.now() - son < 30 * 60000) return;
  otoDeneme = true; // bu sayfa açılışında bir kez
  try { localStorage.setItem(OTO_ANAHTAR, String(Date.now())); } catch { /* */ }
  const s = await ghDispatch("fetch-nesine.yml", { force: "false" });
  if (s === "ok") otoNot = "Bugünün kuponları henüz oluşmamıştı; GitHub çalıştırıldı. 1–2 dakika içinde burada görünür.";
  else otoNot = "Bugünün kuponları henüz yok ve GitHub otomatik başlatılamadı (" + s + "). GitHub'da Actions → Nesine bülteni → Run workflow ile elle çalıştırabilirsin.";
  renderAI();
}
let otoNot = "";

async function sor(metin, mod) {
  if (!adminMi()) return;
  metin = String(metin || "").trim().slice(0, 300);
  if (metin.length < 3) return;
  const btn = tahminRoot.querySelector("#thm-chat-btn");
  btn.disabled = true;
  try {
    await authReady;
    const ref = await addDoc(collection(db, "analizler"), { soru: metin, durum: "bekliyor", olusturma: serverTimestamp(), kim: ADMIN_ADI, mod: ["prompt", "gemini", "claude"].includes(mod) ? mod : "prompt" });
    await tetikle(ref.id);
  } catch (err) {
    console.error(err);
    chatNot("Soru kaydedilemedi: " + (err.code || err.message));
  } finally { btn.disabled = false; }
}

const citeTemizle = s => String(s ?? "").replace(/<\/?cite[^>]*>/gi, "").replace(/\s+([.,;:!?])/g, "$1").replace(/ {2,}/g, " ").trim();
const tx = s => esc(citeTemizle(s));
const dizi = x => (Array.isArray(x) ? x : x ? [x] : []).map(v => typeof v === "string" ? v : (v && (v.oyuncu ? `${v.oyuncu}${v.neden ? " (" + v.neden + ")" : ""}` : JSON.stringify(v))) || "").filter(Boolean);
const maddeler = x => { const l = dizi(x); return l.length ? `<ul>${l.map(v => `<li>${tx(v)}</li>`).join("")}</ul>` : ""; };
const bolum = (b, ic) => ic ? `<div class="thm-an-bolum"><h6>${esc(b)}</h6>${ic}</div>` : "";
const par = x => x ? `<p>${tx(x)}</p>` : "";
const guvenSinif = g => ({ "yüksek": "yuksek", "orta": "orta", "düşük": "dusuk" })[String(g || "").toLowerCase()] || "orta";
const ETIKET = { ozet: "Özet", yorum: "Yorum", puan_durumu: "Puan durumu", h2h: "Karşılaşma geçmişi", oran_degerlendirme: "Oran değerlendirmesi", baslik: "Maç" };

// Eski/bozuk kayıtlar: JSON'u metin olarak kaydedilmiş cevabı toparlar
function cevapNesne(c) {
  if (!c || !c.ham || typeof c.yorum !== "string") return c;
  const s = citeTemizle(c.yorum), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { const o = JSON.parse(s.slice(a, b + 1)); if (o && typeof o === "object" && !Array.isArray(o)) return { ...o, kaynaklar: c.kaynaklar, mac: c.mac, uyarilar: c.uyarilar, uyari: c.uyari }; } catch { /* yarım JSON */ }
  }
  return { ...c, yorum: s };
}
function hamSatirlar(s) {
  const satirlar = [];
  s.replace(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g, (m, k, v) => { satirlar.push([k, v.replace(/\\n/g, "\n").replace(/\\"/g, '"')]); return m; });
  return satirlar;
}
const ozetEtiketi = a => {
  const c = cevapNesne(a.cevap);
  const t = c && Array.isArray(c.tahminler) && c.tahminler[0];
  return t && t.pazar ? `${t.pazar} · ${t.guven || "?"}` : "";
};

function cevapHtml(c0, id) {
  const c = cevapNesne(c0);
  if (!c) return `<p class="thm-bos">Cevap boş geldi. Aynı soruyu tekrar sor.</p>`;
  if (c.tip === "red") return `<p>${esc(c.yorum)}</p>`;
  if (c.tip === "prompt") return `
    <p><b>${esc(c.mac ? c.mac.ev + " - " + c.mac.dep : "Maç")}</b> verisi hazır. Metni kopyala, Claude.ai veya ChatGPT'de yeni bir sohbete yapıştır; internet araştırmasını o sohbet yapar.</p>
    <textarea class="thm-prompt" readonly rows="6">${esc(c.prompt)}</textarea>
    <div class="thm-prompt-btn"><button type="button" class="thm-chat-btn" data-thm-kopya="1">Kopyala</button>
    <a class="thm-chat-btn thm-ikincil" href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Claude.ai'de aç</a>
    <a class="thm-chat-btn thm-ikincil" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT'de aç</a></div>
    ${Array.isArray(c.uyarilar) && c.uyarilar.length ? `<p class="thm-an-uyari">ℹ ${esc(c.uyarilar.join(" "))}</p>` : ""}`;
  if (c.ham) {
    const sat = hamSatirlar(c.yorum || "");
    if (sat.length) return sat.map(([k, v]) => bolum(ETIKET[k] || k, par(v))).join("");
    return c.yorum ? `<p>${tx(c.yorum)}</p>` : `<p class="thm-bos">Cevap boş geldi. Aynı soruyu tekrar sor.</p>`;
  }
  const sak = c.sakatlik_ceza || {};
  const ad = (k, v) => (c.mac && c.mac[k]) || v;
  const tahminler = (Array.isArray(c.tahminler) ? c.tahminler : []).filter(t => t && t.pazar).map(t =>
    `<div class="thm-tahmin"><div class="thm-tahmin-ust"><b>${tx(t.pazar)}</b><span class="thm-guven ${guvenSinif(t.guven)}">${tx(t.guven || "orta")}</span></div>${par(t.gerekce)}</div>`).join("");
  const form = c.form && typeof c.form === "object" ? `<ul><li><b>${esc(ad("ev", "Ev"))}:</b> ${tx(c.form.ev)}</li><li><b>${esc(ad("dep", "Deplasman"))}:</b> ${tx(c.form.dep)}</li></ul>` : par(c.form);
  const sakH = (dizi(sak.ev).length || dizi(sak.dep).length || sak.not)
    ? `<ul><li><b>${esc(ad("ev", "Ev"))}:</b> ${tx(dizi(sak.ev).join("; ") || "bildirilen yok")}</li><li><b>${esc(ad("dep", "Deplasman"))}:</b> ${tx(dizi(sak.dep).join("; ") || "bildirilen yok")}</li></ul>${par(sak.not)}` : "";
  const detay = [bolum("Form", form), bolum("Puan durumu", par(c.puan_durumu)), bolum("Karşılaşma geçmişi", par(c.h2h)), bolum("Sakatlık / ceza", sakH),
    bolum("İnternet araştırması", maddeler(c.haberler)), bolum("Oran değerlendirmesi", par(c.oran_degerlendirme)), bolum("Riskler", maddeler(c.riskler)), bolum("Eksik / doğrulanamayan", maddeler(c.eksik_veri))].join("");
  const kay = (Array.isArray(c.kaynaklar) ? c.kaynaklar : []).filter(k => k && /^https?:\/\//.test(k.url)).map(k => `<a href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">${esc(k.baslik || k.url)}</a>`).join("");
  const notlar = [c.uyari, ...(Array.isArray(c.uyarilar) ? c.uyarilar : [])].filter(Boolean);
  return `
    ${par(c.ozet)}
    ${tahminler ? `<div class="thm-tahminler">${tahminler}</div>` : ""}
    ${c.yorum ? `<div class="thm-an-yorum"><h6>Claude'un yorumu</h6>${par(c.yorum)}</div>` : ""}
    ${detay ? `<details class="thm-detay" data-k="${esc(id)}:detay"><summary>Detaylar</summary>${detay}</details>` : ""}
    ${kay ? `<details class="thm-detay" data-k="${esc(id)}:kaynak"><summary>Kaynaklar (${(kay.match(/<a /g) || []).length})</summary><div class="thm-kaynaklar">${kay}</div></details>` : ""}
    ${notlar.length ? `<p class="thm-an-uyari">ℹ ${esc(notlar.join(" "))}</p>` : ""}
    <p class="thm-an-alt">Analiz yorumudur; kesin sonuç veya yatırım tavsiyesi değildir.</p>`;
}

const kapatilan = new Set(), acilan = new Set(), acikDetay = new Set();
function itemAcKapa(id) {
  const enYeni = analizler[0] && analizler[0].id;
  const acikMi = acilan.has(id) || (id === enYeni && !kapatilan.has(id));
  if (acikMi) { acilan.delete(id); kapatilan.add(id); } else { kapatilan.delete(id); acilan.add(id); }
  renderChat();
}
async function analizSil(id) {
  try { await deleteDoc(doc(db, "analizler", id)); } catch (err) { console.error(err); chatNot("Silinemedi: " + (err.code || err.message)); }
}
async function tumunuSil() {
  if (!analizler.length || !window.confirm(`${analizler.length} analiz kalıcı olarak silinsin mi?`)) return;
  for (const a of [...analizler]) { try { await deleteDoc(doc(db, "analizler", a.id)); } catch (err) { console.error(err); chatNot("Bazıları silinemedi: " + (err.code || err.message)); break; } }
}

function renderChat() {
  const kutu = tahminRoot && tahminRoot.querySelector("#thm-chat-list");
  if (!kutu) return;
  kutu.querySelectorAll("details[data-k]").forEach(d => { if (d.open) acikDetay.add(d.dataset.k); else acikDetay.delete(d.dataset.k); });
  if (!analizler.length) { kutu.innerHTML = `<p class="thm-chat-bos">Henüz analiz yok. Yukarıya bir maç yazarak başla.</p>`; return; }
  const simdi = Date.now();
  kutu.innerHTML = analizler.map((a, i) => {
    const ms = a.olusturma && a.olusturma.toMillis ? a.olusturma.toMillis() : simdi;
    const bekliyor = a.durum === "bekliyor" || a.durum === "calisiyor";
    const takildi = bekliyor && (simdi - ms) / 6e4 > TAKILDI_DK;
    const acik = acilan.has(a.id) || (i === 0 && !kapatilan.has(a.id));
    const mod = esc(a.mod || "prompt");
    let durum, cevap;
    if (a.durum === "bitti") { durum = ozetEtiketi(a) || (a.cevap && a.cevap.tip === "prompt" ? "Prompt hazır" : a.cevap && a.cevap.tip === "red" ? "Maç değil" : "Hazır"); cevap = cevapHtml(a.cevap, a.id); }
    else if (a.durum === "hata") { durum = "Hata"; cevap = `<p>Analiz yapılamadı: ${esc(a.hata || "bilinmeyen hata")}</p><button class="thm-chat-btn thm-ikincil" data-thm-tekrar="${esc(a.soru)}" data-thm-mod="${mod}">Yeniden sor</button>`; }
    else if (takildi) { durum = "Gecikti"; cevap = `<p>Beklenenden uzun sürdü. GitHub'daki çalışma gecikmiş olabilir.</p><button class="thm-chat-btn thm-ikincil" data-thm-tekrar="${esc(a.soru)}" data-thm-mod="${mod}">Yeniden sor</button>`; }
    else { durum = a.durum === "calisiyor" ? "Çalışıyor" : "Sırada"; cevap = `<p class="thm-yaziyor">${a.durum === "calisiyor" ? "Araştırıyor ve analiz yazıyor" : "Sırada"}<span>.</span><span>.</span><span>.</span> <small>(1–3 dk)</small></p>`; }
    const sinif = a.durum === "bitti" ? "tamam" : a.durum === "hata" ? "hata" : "bekle";
    return `<article class="thm-item ${acik ? "acik" : ""}">
      <div class="thm-item-bas" data-thm-ac="${esc(a.id)}" role="button" tabindex="0">
        <div class="thm-item-metin"><b class="thm-item-soru">${esc(a.soru)}</b><small>${esc(MOD_ETIKET[a.mod] || "Prompt")} · ${esc(fmtTime(new Date(ms).toISOString()))}</small></div>
        <span class="thm-item-durum ${sinif}">${esc(durum)}</span>
        <span class="thm-item-ok" aria-hidden="true">${acik ? "▴" : "▾"}</span>
        <button type="button" class="thm-sil" data-thm-sil="${esc(a.id)}" title="Sil" aria-label="Sil">✕</button>
      </div>
      ${acik ? `<div class="thm-item-govde">${cevap}</div>` : ""}
    </article>`;
  }).join("") + `<button type="button" class="thm-temizle" data-thm-temizle>Tüm geçmişi sil</button>`;
  kutu.querySelectorAll("details[data-k]").forEach(d => { if (acikDetay.has(d.dataset.k)) d.open = true; });
}

function sohbetBaslat() {
  if (sohbetBasladi) return;
  sohbetBasladi = true;
  authReady.then(() => {
    onSnapshot(query(collection(db, "analizler"), orderBy("olusturma", "desc"), limit(30)), snap => {
      analizler = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderChat();
    }, err => console.error("analizler okunamadı:", err));
  });
}
setInterval(() => { if (sohbetBasladi && tahminRoot && tahminRoot.classList.contains("active") && analizler.some(a => a.durum === "bekliyor" || a.durum === "calisiyor")) renderChat(); }, 30000);

const SONUC_ETIKET = { open: "Açık", won: "Tuttu", lost: "Yattı", void: "İptal" };
const kuponDurumu = k => ["open", "won", "lost", "void"].includes(k.status) ? k.status : "open";
const yuzde = x => (x == null || isNaN(x)) ? "—" : "%" + Math.round(x * 100);

function istatistik(liste) {
  const s = { toplam: liste.length, sonuclanan: 0, tutan: 0, kar: 0, secim: 0, secimTutan: 0, olasilikToplam: 0, olasilikAdet: 0, pazar: {} };
  liste.forEach(k => {
    const d = kuponDurumu(k);
    if (d === "won" || d === "lost") {
      s.sonuclanan++;
      if (d === "won") { s.tutan++; s.kar += SANAL_BAHIS * ((k.settledOdd || k.totalOdd || 1) - 1); } else s.kar -= SANAL_BAHIS;
    }
    (k.picks || []).forEach(p => {
      if (p.result !== "won" && p.result !== "lost") return;
      s.secim++;
      if (p.result === "won") s.secimTutan++;
      const pz = (s.pazar[p.market] = s.pazar[p.market] || { n: 0, t: 0 });
      pz.n++; if (p.result === "won") pz.t++;
      if (typeof p.prob === "number") { s.olasilikToplam += p.prob; s.olasilikAdet++; }
    });
  });
  return s;
}

const GRUPLAR = [
  { id: "guvenli", ad: "Güvenli", not: "Kupon 1 · her seçim ≥1,40" },
  { id: "dengeli", ad: "Orta", not: "Kupon 2 · her seçim ≥1,70" },
  { id: "riskli", ad: "Riskli", not: "Kupon 3 · her seçim ≥2,00" }
];
function grupOf(k) {
  const t = k.tur || ({ 1: "guvenli", 2: "dengeli", 3: "dengeli", 4: "tekli", 5: "riskli" })[k.slot];
  return t === "tekli" ? "guvenli" : (t || "dengeli");
}
// Yeni düzen (3 kupon) kayıtlarında sema === 2 yazar; eski 5 kuponluk düzen ayrı tutulur ki istatistikler karışmasın.
const yeniDuzen = k => k.sema === 2;
function grupKarti(g, liste) {
  const s = istatistik(liste.filter(k => grupOf(k) === g.id));
  const gercek = s.secim ? s.secimTutan / s.secim : null;
  const beklenen = s.olasilikAdet ? s.olasilikToplam / s.olasilikAdet : null;
  return `<div class="thm-grup">
    <h5>${g.ad} <small>${g.not}</small></h5>
    <dl>
      <div><dt>Sonuçlanan</dt><dd>${s.sonuclanan} / ${s.toplam}</dd></div>
      <div><dt>Tutan kupon</dt><dd>${s.tutan}${s.sonuclanan ? " (" + yuzde(s.tutan / s.sonuclanan) + ")" : ""}</dd></div>
      <div><dt>Seçim isabeti</dt><dd>${yuzde(gercek)} <small>(beklenen ${yuzde(beklenen)})</small></dd></div>
      <div><dt>Sanal kâr/zarar</dt><dd class="${s.kar >= 0 ? "win" : "lose"}">${s.kar >= 0 ? "+" : ""}${Math.round(s.kar)}₺</dd></div>
    </dl>
  </div>`;
}

function kuponKarti(k) {
  const d = kuponDurumu(k);
  const picks = (k.picks || []).map(p => {
    const simge = p.result === "won" ? "✓" : p.result === "lost" ? "✗" : p.result === "void" ? "–" : "";
    return `<li class="thm-pick ${esc(p.result || "")}">
      <span class="thm-pt">${esc(p.t || "")}</span>
      <div class="thm-pm"><b>${esc(p.h)} – ${esc(p.a)}</b><small>${esc(p.lg || "")}${p.deger ? ` · <span class="thm-deger" title="Nesine oranı × (Nesine+Bet365) ortalama olasılığı. 1'in üstü: Nesine fiyatı ortalamaya göre cömert. Kâr garantisi değildir.">Değer ${Number(p.deger).toFixed(2)}</span>` : ""}</small></div>
      <span class="thm-ps">${esc(p.pickLabel || p.pick || "")}</span>
      <span class="thm-po">${fmtOdd(p.odd)}</span>
      <span class="thm-pp" title="AI'nın tahmin ettiği olasılık">${yuzde(p.prob)}</span>
      <span class="thm-pr">${simge}</span>
      ${p.reason ? `<p class="thm-why">${esc(p.reason)}</p>` : ""}
      ${p.risk ? `<p class="thm-risk">Risk: ${esc(p.risk)}</p>` : ""}
    </li>`;
  }).join("");
  const birlesik = (k.picks || []).length && k.picks.every(p => typeof p.prob === "number")
    ? k.picks.reduce((a, p) => a * p.prob, 1) : null;
  return `<article class="thm-coupon ${d}">
    <header><h4>${esc(k.label || "Kupon " + (k.slot || ""))}</h4><span class="thm-chip ${d}">${SONUC_ETIKET[d]}</span></header>
    <ul class="thm-picks">${picks}</ul>
    <footer>
      <span>Toplam oran <b>${fmtOdd(k.totalOdd)}</b></span>
      <span>Birleşik olasılık <b>${yuzde(birlesik)}</b></span>
      <span>Sanal ${SANAL_BAHIS}₺ → <b>${fmtOdd(((d === "won" && k.settledOdd) || k.totalOdd || 0) * SANAL_BAHIS).replace(".00", "")}₺</b></span>
      <span class="thm-kaynak">Oranlar: ${esc(k.oddsSource || "Nesine")} · ${fmtTime(k.oddsAt)}</span>
    </footer>
  </article>`;
}

function aiDurumHtml() {
  const bugun = dayKey(0);
  const bugunVar = aiKuponlar.some(k => k.dateKey === bugun);
  if (bugunVar || (!aiDurum && !otoNot)) return "";
  const hata = aiDurum && aiDurum.ok === false;
  const son = aiDurum ? `${hata ? "Son çalışma hatası: " + esc(aiDurum.message || "") : "Son çalışma: " + esc(aiDurum.message || "")}
    <br><small>Son deneme: ${fmtTime(aiDurum.lastRun)}. Sistem sabah 08:07'den itibaren yarım saatte bir otomatik dener.</small>` : "";
  return `<div class="thm-durum uyari"><b>Bugünün kuponları henüz yok.</b> ${son}${otoNot ? `<br><small>${esc(otoNot)}</small>` : ""}</div>`;
}

function renderAI() {
  const kutu = tahminRoot && tahminRoot.querySelector("#thm-ai");
  if (!kutu) return;
  if (!aiKuponlar.length) {
    kutu.innerHTML = aiDurumHtml() + `<div class="thm-bos-kutu">
      <b>Henüz AI kuponu yok.</b>
      <p>Her sabah 08:00'den sonra 3 kupon (Güvenli, Orta, Riskli) burada görünür.</p>
    </div>`;
    return;
  }
  const s = istatistik(aiKuponlar);
  const yeniKuponlar = aiKuponlar.filter(yeniDuzen), eskiKuponlar = aiKuponlar.filter(k => !yeniDuzen(k));
  const eskiS = istatistik(eskiKuponlar);
  const gunler = [...new Set(aiKuponlar.map(k => k.dateKey))];
  if (!state.aiGun || !gunler.includes(state.aiGun)) state.aiGun = gunler[0];
  const secili = aiKuponlar.filter(k => k.dateKey === state.aiGun);
  const gercek = s.secim ? s.secimTutan / s.secim : null;
  const beklenen = s.olasilikAdet ? s.olasilikToplam / s.olasilikAdet : null;
  const pazarSatir = Object.entries(s.pazar).sort((a, b) => b[1].n - a[1].n).map(([pz, v]) =>
    `<tr><td>${esc(pz)}</td><td>${v.n}</td><td>${yuzde(v.t / v.n)}</td></tr>`).join("");

  kutu.innerHTML = `
    ${aiDurumHtml()}
    <div class="thm-stat">
      <div><i>Kupon</i><b>${s.toplam}</b></div>
      <div><i>Sonuçlanan</i><b>${s.sonuclanan}</b></div>
      <div><i>Tutan kupon</i><b>${s.tutan}</b></div>
      <div><i>Kupon isabeti</i><b>${s.sonuclanan ? yuzde(s.tutan / s.sonuclanan) : "—"}</b></div>
      <div><i>Seçim isabeti</i><b>${yuzde(gercek)}</b></div>
      <div><i>Sanal kâr/zarar</i><b class="${s.kar >= 0 ? "win" : "lose"}">${s.kar >= 0 ? "+" : ""}${Math.round(s.kar)}₺</b></div>
    </div>
    <p class="thm-kalib"><b>Yeni düzen (3 kupon: Güvenli / Orta / Riskli)</b> istatistikleri${yeniKuponlar.length ? "" : " — ilk kuponlar sonuçlanınca burada görünecek"}:</p>
    <div class="thm-gruplar">${GRUPLAR.map(g => grupKarti(g, yeniKuponlar)).join("")}</div>
    ${eskiKuponlar.length ? `<p class="thm-kalib">Eski 5 kuponluk düzen (${eskiS.sonuclanan} sonuçlanan kupon): ${eskiS.tutan} tuttu${eskiS.sonuclanan ? " (" + yuzde(eskiS.tutan / eskiS.sonuclanan) + ")" : ""}, seçim isabeti ${yuzde(eskiS.secim ? eskiS.secimTutan / eskiS.secim : null)}. Aşağıdaki genel kutulara dahildir, yukarıdaki kartlara dahil değildir.</p>` : ""}
    <p class="thm-kalib">Kalibrasyon: AI'nın verdiği ortalama olasılık <b>${yuzde(beklenen)}</b>, gerçekleşen <b>${yuzde(gercek)}</b>.
      ${s.secim < 30 ? "Örnek sayısı az (" + s.secim + " seçim), erken yorum yapmayın." : ""}
      Sanal kâr/zarar her kupona ${SANAL_BAHIS}₺ sabit bahis varsayılarak hesaplanır.</p>
    ${pazarSatir ? `<details class="thm-pazar"><summary>Pazara göre isabet</summary><table><thead><tr><th>Pazar</th><th>Seçim</th><th>İsabet</th></tr></thead><tbody>${pazarSatir}</tbody></table></details>` : ""}
    <div class="thm-gunler">${gunler.slice(0, 14).map(g =>
      `<button type="button" class="filter-btn ${g === state.aiGun ? "active" : ""}" data-thm-aigun="${esc(g)}">${TR_DATE(g)}</button>`).join("")}</div>
    <div class="thm-kuponlar">${secili.map(kuponKarti).join("")}</div>`;
}

/* ================= Veri abonelikleri ================= */
function baslat() {
  if (basladi) return;
  basladi = true;
  authReady.then(() => {
    [0, 1].forEach(off => {
      const k = dayKey(off);
      onSnapshot(doc(db, "bulten", k), snap => {
        if (snap.exists()) {
          const d = snap.data();
          let liste = [];
          try { liste = JSON.parse(d.json || "[]"); } catch { /* bozuk veri */ }
          bulten[k] = { maclar: liste, guncelleme: d.updatedAt, adet: d.count ?? liste.length };
        } else delete bulten[k];
        renderMaclar();
      }, err => console.error("bulten okunamadı:", err));
      onSnapshot(doc(db, "liveMatches", k), snap => {
        apiGun[k] = snap.exists() ? (snap.data().matches || []) : [];
        renderMaclar();
      }, err => console.error("liveMatches okunamadı:", err));
    });
    onSnapshot(doc(db, "bulten", "status"), snap => { durum = snap.exists() ? snap.data() : null; renderMaclar(); },
      err => console.error("bulten/status okunamadı:", err));
    onSnapshot(doc(db, "bulten", "aiStatus"), snap => { aiDurum = snap.exists() ? snap.data() : null; renderAI(); },
      err => console.error("bulten/aiStatus okunamadı:", err));
    onSnapshot(query(collection(db, "aiCoupons"), orderBy("dateKey", "desc"), limit(200)), snap => {
      aiKuponlar = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.dateKey || "").localeCompare(a.dateKey || "") || (a.slot || 0) - (b.slot || 0));
      aiYuklendi = true;
      renderAI();
      otoTetik();
    }, err => console.error("aiCoupons okunamadı:", err));
  });
}

function init() {
  const dene = () => { const a = mountMaclar(), b = mountTahminler(); return a && b; };
  if (dene()) { sekmeGorunurluk(); baslat(); renderMaclar(); return; }
  let n = 0;
  const t = setInterval(() => {
    if (dene()) { clearInterval(t); sekmeGorunurluk(); baslat(); renderMaclar(); } else if (++n > 40) clearInterval(t);
  }, 250);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
