// Tahminler sekmesi: (1) Tüm maçlar ve oranlar (Nesine bülteni), (2) AI tahminleri.
// index.html'e tek satır eklenir: <script type="module" src="tahminler.js"></script>
// Sekme düğmesini ve sayfayı kendisi ekler; app.js'e dokunmaz.

import { db, authReady } from "./firebase-config.js";
import {
  doc, onSnapshot, collection, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SANAL_BAHIS = 100;          // AI kuponları için varsayımsal sabit tutar (₺)
const TZ = "Europe/Istanbul";
const BAYAT_SAAT = 26;            // bülten bundan eskiyse uyarı göster

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dayKey = (offset = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + offset * 864e5));
const nowHM = () =>
  new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const fmtOdd = o => (o == null ? "–" : Number(o).toFixed(2));
const fmtTime = iso => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : new Intl.DateTimeFormat("tr-TR", {
    timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(d);
};
const TR_DATE = k => k.split("-").reverse().join(".");

// Pazar tanımları (Nesine pazar kodları doğrulandı; sıra: bülten sırası)
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

const state = { gun: "today", ara: "", gizle: true, acik: new Set(), aiGun: null };
const bulten = {};        // tarih -> { maclar:[], guncelleme, adet }
let durum = null;         // bulten/status
let aiKuponlar = [];      // aiCoupons (en yeniden eskiye)
let started = false;
let root = null;

/* ---------------- Sayfa iskeleti ---------------- */
function mount() {
  const matchesView = document.getElementById("view-matches");
  const navMatches = document.querySelector('.nav-btn[data-view="matches"]');
  if (!matchesView || !navMatches || document.getElementById("view-tahminler")) return !!document.getElementById("view-tahminler");

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

  root = document.createElement("main");
  root.id = "view-tahminler";
  root.className = "view view-tahminler";
  root.innerHTML = `
    <div class="thm-head">
      <div>
        <h2 class="section-title">Tahminler</h2>
        <p class="section-sub">Günün maçları ve oranları, bir de AI'nın kendi kuponları.</p>
      </div>
    </div>

    <section class="thm-section" aria-labelledby="thm-h-maclar">
      <h3 id="thm-h-maclar" class="thm-h">Tüm Maçlar ve Oranlar</h3>
      <div id="thm-durum" class="thm-durum"></div>
      <div class="thm-tools">
        <div class="matches-day-tabs">
          <button class="filter-btn active" data-thm-gun="today">Bugün</button>
          <button class="filter-btn" data-thm-gun="tomorrow">Yarın</button>
        </div>
        <input id="thm-ara" class="thm-ara" type="search" placeholder="Takım veya lig ara" autocomplete="off">
        <label class="thm-chk"><input id="thm-gizle" type="checkbox" checked> Başlayanları gizle</label>
      </div>
      <div id="thm-liste" class="thm-liste"></div>
    </section>

    <section class="thm-section" aria-labelledby="thm-h-ai">
      <h3 id="thm-h-ai" class="thm-h">AI Tahminler</h3>
      <div id="thm-ai"></div>
    </section>`;
  matchesView.insertAdjacentElement("afterend", root);

  btn.addEventListener("click", () => {
    document.querySelectorAll(".app-shell .view").forEach(v => v.classList.remove("active"));
    root.classList.add("active");
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b === btn));
    start();
  });

  root.addEventListener("click", e => {
    const g = e.target.closest("[data-thm-gun]");
    if (g) {
      state.gun = g.dataset.thmGun;
      root.querySelectorAll("[data-thm-gun]").forEach(b => b.classList.toggle("active", b === g));
      return renderMaclar();
    }
    const more = e.target.closest("[data-thm-more]");
    if (more) {
      const id = more.dataset.thmMore;
      state.acik.has(id) ? state.acik.delete(id) : state.acik.add(id);
      return renderMaclar();
    }
    const aiSec = e.target.closest("[data-thm-aigun]");
    if (aiSec) { state.aiGun = aiSec.dataset.thmAigun; renderAI(); }
  });
  root.querySelector("#thm-ara").addEventListener("input", e => { state.ara = e.target.value.trim().toLocaleLowerCase("tr"); renderMaclar(); });
  root.querySelector("#thm-gizle").addEventListener("change", e => { state.gizle = e.target.checked; renderMaclar(); });
  return true;
}

/* ---------------- Veri ---------------- */
function start() {
  if (started) { renderMaclar(); renderAI(); return; }
  started = true;
  renderMaclar(); renderAI();
  authReady.then(() => {
    [0, 1].forEach(off => {
      const k = dayKey(off);
      onSnapshot(doc(db, "bulten", k), snap => {
        if (snap.exists()) {
          const d = snap.data();
          let maclar = [];
          try { maclar = JSON.parse(d.json || "[]"); } catch { /* bozuk veri */ }
          bulten[k] = { maclar, guncelleme: d.updatedAt, adet: d.count ?? maclar.length };
        } else {
          delete bulten[k];
        }
        renderMaclar();
      }, err => console.error("bulten okunamadı:", err));
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

/* ---------------- 1) Maçlar ve oranlar ---------------- */
function oranHucreleri(def, dizi) {
  return def.etiket.map((et, i) =>
    `<span class="thm-o"><i>${esc(et)}</i><b>${fmtOdd(dizi && dizi[i])}</b></span>`).join("");
}

function macSatiri(m) {
  const id = String(m.id);
  const acik = state.acik.has(id);
  const ana = ANA.map(def => `<span class="thm-grp" title="${esc(def.baslik)}"><em>${esc(def.baslik)}</em>${oranHucreleri(def, m.m && m.m[def.k])}</span>`).join("");
  const ek = acik ? `<div class="thm-ek">${EK.filter(def => m.m && m.m[def.k]).map(def =>
    `<span class="thm-grp"><em>${esc(def.baslik)}</em>${oranHucreleri(def, m.m[def.k])}</span>`).join("") || "<span class='thm-bos'>Ek oran yok</span>"}</div>` : "";
  return `<div class="thm-row">
    <div class="thm-time">${esc(m.t)}</div>
    <div class="thm-teams"><b>${esc(m.h)}</b><span>${esc(m.a)}</span>${m.mbs > 1 ? `<small class="thm-mbs" title="Bu maç için minimum seçim sayısı">MBS ${esc(m.mbs)}</small>` : ""}</div>
    <div class="thm-odds">${ana}</div>
    <button class="thm-more" type="button" data-thm-more="${esc(id)}" aria-expanded="${acik}" title="Diğer oranlar">${acik ? "−" : "+"}</button>
    ${ek}
  </div>`;
}

function renderMaclar() {
  if (!root) return;
  const key = dayKey(state.gun === "today" ? 0 : 1);
  const veri = bulten[key];
  const durumEl = root.querySelector("#thm-durum");
  const liste = root.querySelector("#thm-liste");

  // Durum satırı
  let not = `Oranlar Nesine bülteninden her sabah alınır. Bülten saati önemlidir: oranlar gün içinde değişir.`;
  let sinif = "";
  if (veri) {
    const yas = (Date.now() - new Date(veri.guncelleme).getTime()) / 36e5;
    not = `Son güncelleme: <b>${fmtTime(veri.guncelleme)}</b> · ${veri.adet} maç. ` + not;
    if (yas > BAYAT_SAAT) { sinif = "uyari"; not = `⚠️ Veri ${Math.round(yas)} saatten eski. ` + not; }
  } else {
    sinif = "uyari";
    not = `⚠️ ${TR_DATE(key)} için bülten henüz alınmadı. ` + not;
  }
  if (durum && durum.ok === false) {
    sinif = "uyari";
    not = `⚠️ Son çekim başarısız (${fmtTime(durum.lastRun)}): ${esc(durum.message || "bilinmeyen hata")}. ` + not;
  }
  durumEl.className = "thm-durum " + sinif;
  durumEl.innerHTML = not;

  if (!veri) { liste.innerHTML = `<p class="thm-bos">Gösterilecek maç yok.</p>`; return; }

  const simdi = nowHM();
  const bugunMu = key === dayKey(0);
  let maclar = veri.maclar.filter(m => {
    if (state.gizle && bugunMu && m.t < simdi) return false;
    if (state.ara) return (`${m.h} ${m.a} ${m.lg}`).toLocaleLowerCase("tr").includes(state.ara);
    return true;
  });
  if (!maclar.length) { liste.innerHTML = `<p class="thm-bos">Bu filtreyle maç bulunamadı.</p>`; return; }

  const gruplar = new Map();
  maclar.forEach(m => { if (!gruplar.has(m.lg)) gruplar.set(m.lg, []); gruplar.get(m.lg).push(m); });
  const sirali = [...gruplar.entries()].sort((a, b) => a[1][0].t.localeCompare(b[1][0].t) || a[0].localeCompare(b[0], "tr"));
  liste.innerHTML = `<p class="thm-say">${maclar.length} maç · ${sirali.length} lig</p>` + sirali.map(([lg, ms]) =>
    `<div class="thm-lig"><h4>${esc(lg)}</h4>${ms.map(macSatiri).join("")}</div>`).join("");
}

/* ---------------- 2) AI tahminleri ---------------- */
const SONUC_ETIKET = { open: "Açık", won: "Tuttu", lost: "Yattı", void: "İptal" };
const kuponDurumu = k => ["open", "won", "lost", "void"].includes(k.status) ? k.status : "open";
const yuzde = x => (x == null || isNaN(x)) ? "—" : "%" + Math.round(x * 100);

function istatistik(liste) {
  const s = { toplam: liste.length, sonuclanan: 0, tutan: 0, kar: 0, secim: 0, secimTutan: 0, olasilikToplam: 0, olasilikAdet: 0, pazar: {} };
  liste.forEach(k => {
    const d = kuponDurumu(k);
    if (d === "won" || d === "lost") {
      s.sonuclanan++;
      if (d === "won") { s.tutan++; s.kar += SANAL_BAHIS * ((k.totalOdd || 1) - 1); } else s.kar -= SANAL_BAHIS;
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
  const birlesik = (k.picks || []).every(p => typeof p.prob === "number") && (k.picks || []).length
    ? k.picks.reduce((a, p) => a * p.prob, 1) : null;
  return `<article class="thm-coupon ${d}">
    <header><h4>${esc(k.label || "Kupon " + (k.slot || ""))}</h4><span class="thm-chip ${d}">${SONUC_ETIKET[d]}</span></header>
    <ul class="thm-picks">${picks}</ul>
    <footer>
      <span>Toplam oran <b>${fmtOdd(k.totalOdd)}</b></span>
      <span>Birleşik olasılık <b>${yuzde(birlesik)}</b></span>
      <span>Sanal ${SANAL_BAHIS}₺ → <b>${fmtOdd((k.totalOdd || 0) * SANAL_BAHIS).replace(".00", "")}₺</b></span>
      <span class="thm-kaynak">Oranlar: ${esc(k.oddsSource || "Nesine")} · ${fmtTime(k.oddsAt)}</span>
    </footer>
  </article>`;
}

function renderAI() {
  if (!root) return;
  const kutu = root.querySelector("#thm-ai");
  if (!aiKuponlar.length) {
    kutu.innerHTML = `<div class="thm-bos-kutu">
      <b>Henüz AI kuponu yok.</b>
      <p>Tahmin yöntemi belirlendikten sonra her sabah 5 kupon burada görünecek. AI bu kuponları kendisi oynamış gibi kaydeder ve kendi başarısını ayrı tutar. Sizin kuponlarınızla karışmaz.</p>
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

/* ---------------- Başlat ---------------- */
function init() {
  if (mount()) return;
  // app.js sayfayı hazırlarken biraz bekleyebilir
  let n = 0;
  const t = setInterval(() => { if (mount() || ++n > 40) clearInterval(t); }, 250);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
