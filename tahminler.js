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
  doc, onSnapshot, collection, query, orderBy, limit
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
let tahminRoot = null;
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

  tahminRoot = document.createElement("main");
  tahminRoot.id = "view-tahminler";
  tahminRoot.className = "view view-tahminler";
  tahminRoot.innerHTML = `
    <div class="thm-head">
      <h2 class="section-title">AI Tahminler</h2>
      <p class="section-sub">AI'nın her gün kendi seçtiği kuponlar. AI bunları kendisi oynamış gibi kaydeder, sonuçları ve başarısı sizin kuponlarınızdan ayrı tutulur. Günün tüm maçları ve oranları <b>Maçlar</b> sekmesinde.</p>
    </div>
    <div id="thm-ai"></div>`;
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
  });
  return true;
}

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

function kuponKarti(k) {
  const d = kuponDurumu(k);
  const picks = (k.picks || []).map(p => {
    const simge = p.result === "won" ? "✓" : p.result === "lost" ? "✗" : p.result === "void" ? "–" : "";
    return `<li class="thm-pick ${esc(p.result || "")}">
      <span class="thm-pt">${esc(p.t || "")}</span>
      <div class="thm-pm"><b>${esc(p.h)} – ${esc(p.a)}</b><small>${esc(p.lg || "")}</small></div>
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

function renderAI() {
  const kutu = tahminRoot && tahminRoot.querySelector("#thm-ai");
  if (!kutu) return;
  if (!aiKuponlar.length) {
    kutu.innerHTML = `<div class="thm-bos-kutu">
      <b>Henüz AI kuponu yok.</b>
      <p>Tahmin yöntemi belirlendikten sonra her sabah 5 kupon burada görünecek.</p>
    </div>`;
    return;
  }
  const s = istatistik(aiKuponlar);
  const gunler = [...new Set(aiKuponlar.map(k => k.dateKey))];
  if (!state.aiGun || !gunler.includes(state.aiGun)) state.aiGun = gunler[0];
  const secili = aiKuponlar.filter(k => k.dateKey === state.aiGun);
  const gercek = s.secim ? s.secimTutan / s.secim : null;
  const beklenen = s.olasilikAdet ? s.olasilikToplam / s.olasilikAdet : null;
  const pazarSatir = Object.entries(s.pazar).sort((a, b) => b[1].n - a[1].n).map(([pz, v]) =>
    `<tr><td>${esc(pz)}</td><td>${v.n}</td><td>${yuzde(v.t / v.n)}</td></tr>`).join("");

  kutu.innerHTML = `
    <div class="thm-stat">
      <div><i>Kupon</i><b>${s.toplam}</b></div>
      <div><i>Sonuçlanan</i><b>${s.sonuclanan}</b></div>
      <div><i>Tutan kupon</i><b>${s.tutan}</b></div>
      <div><i>Kupon isabeti</i><b>${s.sonuclanan ? yuzde(s.tutan / s.sonuclanan) : "—"}</b></div>
      <div><i>Seçim isabeti</i><b>${yuzde(gercek)}</b></div>
      <div><i>Sanal kâr/zarar</i><b class="${s.kar >= 0 ? "win" : "lose"}">${s.kar >= 0 ? "+" : ""}${Math.round(s.kar)}₺</b></div>
    </div>
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
    onSnapshot(query(collection(db, "aiCoupons"), orderBy("dateKey", "desc"), limit(200)), snap => {
      aiKuponlar = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.dateKey || "").localeCompare(a.dateKey || "") || (a.slot || 0) - (b.slot || 0));
      renderAI();
    }, err => console.error("aiCoupons okunamadı:", err));
  });
}

function init() {
  const dene = () => { const a = mountMaclar(), b = mountTahminler(); return a && b; };
  if (dene()) { baslat(); renderMaclar(); return; }
  let n = 0;
  const t = setInterval(() => {
    if (dene()) { clearInterval(t); baslat(); renderMaclar(); } else if (++n > 40) clearInterval(t);
  }, 250);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
