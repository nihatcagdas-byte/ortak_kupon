"use strict";
// AI kupon motoru: aday üretimi, kural tabanlı kupon kurucu, doğrulama ve sonuç hesabı.
// Ağa ve Firebase'e bağlanmaz; generate-coupons.cjs ve settle-coupons.cjs bunu kullanır.

const TZ = "Europe/Istanbul";
const trTarih = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));
const trHM = (d) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const dk = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
const yuvarla = (x, n = 3) => Math.round(x * 10 ** n) / 10 ** n;

/* ---------------- Takım adı eşleştirme (site ile aynı mantık) ---------------- */
const STOP = new Set(["fc", "sk", "fk", "cf", "afc", "bk", "if", "sc", "ac", "as", "us", "cd", "ud", "club", "de", "the", "ssc", "sv", "vfb", "vfl", "tsv", "kf", "nk", "hnk", "cfr"]);
const ESLE = { utd: "united", intl: "international", psg: "paris saint germain", man: "manchester", atl: "atletico" };

function normalize(s) {
  return String(s == null ? "" : s).toLocaleLowerCase("en").replace(/ı/g, "i")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .map((t) => ESLE[t] || t).filter((t) => t && !STOP.has(t)).join(" ");
}
function bigram(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
function benzerlik(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigram(a), B = bigram(b);
  let ortak = 0, na = 0, nb = 0;
  A.forEach((v, g) => { na += v; if (B.has(g)) ortak += Math.min(v, B.get(g)); });
  B.forEach((v) => { nb += v; });
  let d = na + nb ? (2 * ortak) / (na + nb) : 0;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) d = Math.max(d, 0.85);
  return d;
}
// nesine: [{id,t,h,a}], api: [{date,home,away,...}] -> Map(nesine.id -> api)
function esle(nesine, api, toleransDk = 25) {
  const adaylar = [];
  nesine.forEach((n, i) => api.forEach((a, j) => {
    const d = new Date(a.date);
    if (isNaN(d)) return;
    if (Math.abs(dk(trHM(d)) - dk(n.t)) > toleransDk) return;
    const h = benzerlik(n.h, a.home), v = benzerlik(n.a, a.away);
    if (Math.min(h, v) < 0.4 || (h + v) / 2 < 0.55) return;
    adaylar.push({ i, j, skor: (h + v) / 2 });
  }));
  adaylar.sort((x, y) => y.skor - x.skor);
  const kn = new Set(), ka = new Set(), sonuc = new Map();
  adaylar.forEach((c) => {
    if (kn.has(c.i) || ka.has(c.j)) return;
    kn.add(c.i); ka.add(c.j);
    sonuc.set(nesine[c.i].id, api[c.j]);
  });
  return sonuc;
}

/* ---------------- Olasılık hesapları ---------------- */
const marjsiz = (oranlar) => {
  const ters = oranlar.map((o) => 1 / o);
  const t = ters.reduce((a, b) => a + b, 0);
  return ters.map((x) => x / t);
};
function poissonCdf(k, lam) {
  let t = Math.exp(-lam), c = t;
  for (let i = 1; i <= k; i++) { t *= lam / i; c += t; }
  return c;
}
const sayi = (x) => { const v = parseFloat(x); return isNaN(v) ? null : v; };

// API-Football istatistiğinden ikinci görüş: kazanma yüzdesi + gol ortalamalarından Poisson
function apiGorusu(stats) {
  if (!stats) return null;
  const g = { win: null, lh: null, la: null };
  const w = stats.winPercent;
  if (w) {
    const v = [sayi(w.home), sayi(w.draw), sayi(w.away)];
    if (v.every((x) => x !== null) && v.reduce((a, b) => a + b, 0) > 0) {
      const t = v.reduce((a, b) => a + b, 0);
      g.win = v.map((x) => x / t);
    }
  }
  const ga = stats.goalsAvg || {};
  const hf = sayi(ga.homeFor), ha = sayi(ga.homeAgainst), af = sayi(ga.awayFor), aa = sayi(ga.awayAgainst);
  if ([hf, ha, af, aa].every((x) => x !== null)) { g.lh = (hf + aa) / 2; g.la = (af + ha) / 2; }
  return g.win || g.lh !== null ? g : null;
}

/* ---------------- Aday üretimi ---------------- */
const AU_CIZGI = { au15: 1.5, au25: 2.5, au35: 3.5 };
const virgul = (x) => String(x).replace(".", ",");

function adaylariUret(nesine, eslesen, secenek = {}) {
  const simdiDk = secenek.simdiDk != null ? secenek.simdiDk : 0;
  const minOran = secenek.minOran || 1.12, maxOran = secenek.maxOran || 4.0;
  const b365Gecerli = secenek.b365YasSaat == null || secenek.b365YasSaat <= 24;
  const liste = [];
  nesine.forEach((m) => {
    if (!m.m || !m.m.ms || m.m.ms.length !== 3) return;
    if (dk(m.t) <= simdiDk + 15) return; // başlamış ya da çok yakın
    const api = eslesen && eslesen.get(m.id);
    const st = api && api.stats;
    const g = apiGorusu(st);
    const qN = marjsiz(m.m.ms);                       // Nesine'nin marjsız olasılığı
    // Bet365 (API-Football /odds) ikinci piyasa görüşü; sadece MS var. Çok eskiyse kullanılmaz.
    let qB = null;
    const bo = api && api.odds;
    if (bo && b365Gecerli) {
      const v = [sayi(bo.home), sayi(bo.draw), sayi(bo.away)];
      if (v.every((x) => x !== null && x > 1)) qB = marjsiz(v);
    }
    const q = qB ? qN.map((x, i) => (x + qB[i]) / 2) : qN;   // piyasa ortalaması
    const ek = st ? {
      form: st.form || null, advice: st.advice || null,
      winPercent: st.winPercent || null,
      sakat: st.injuries ? { h: (st.injuries.home || []).length, a: (st.injuries.away || []).length } : null
    } : null;

    // pB: Bet365'in bu seçim için marjsız olasılığı (yoksa null). deger = Nesine oranı x piyasa ortalaması.
    const ekle = (market, pick, pickLabel, odd, pM, pA, pB = null) => {
      if (!(odd >= minOran && odd <= maxOran)) return;
      const p = pA != null ? 0.5 * pM + 0.5 * pA : pM;
      liste.push({
        id: `${m.id}|${pick}`, matchId: m.id, t: m.t, h: m.h, a: m.a, lg: m.lg, mbs: m.mbs || 1,
        market, pick, pickLabel, odd, pM: yuvarla(pM), pA: pA != null ? yuvarla(pA) : null, pB: pB != null ? yuvarla(pB) : null,
        p: yuvarla(p), deger: pB != null ? yuvarla(odd * pM) : null,
        uyum: pA != null && Math.abs(pM - pA) <= 0.12, ek
      });
    };

    // MS
    ["1", "X", "2"].forEach((k, i) => ekle("MS", k, "MS " + k, m.m.ms[i], q[i], g && g.win ? g.win[i] : null, qB ? qB[i] : null));
    // Çifte şans (piyasa olasılığı MS'den türetilir)
    if (m.m.cs && m.m.cs.length === 3) {
      const csP = [q[0] + q[1], q[0] + q[2], q[1] + q[2]];
      const csA = g && g.win ? [g.win[0] + g.win[1], g.win[0] + g.win[2], g.win[1] + g.win[2]] : [null, null, null];
      const csB = qB ? [qB[0] + qB[1], qB[0] + qB[2], qB[1] + qB[2]] : [null, null, null];
      ["1x", "12", "x2"].forEach((k, i) => ekle("Çifte Şans", "cs" + k, "ÇŞ " + k.toUpperCase(), m.m.cs[i], csP[i], csA[i], csB[i]));
    }
    // KG
    if (m.m.kg && m.m.kg.length === 2) {
      const qk = marjsiz(m.m.kg);
      const pVar = g && g.lh !== null ? (1 - Math.exp(-g.lh)) * (1 - Math.exp(-g.la)) : null;
      ekle("KG", "kgvar", "KG Var", m.m.kg[0], qk[0], pVar);
      ekle("KG", "kgyok", "KG Yok", m.m.kg[1], qk[1], pVar != null ? 1 - pVar : null);
    }
    // Alt/Üst
    Object.keys(AU_CIZGI).forEach((key) => {
      const o = m.m[key];
      if (!o || o.length !== 2) return;
      const cizgi = AU_CIZGI[key], qa = marjsiz(o);
      let pAlt = null;
      if (g && g.lh !== null) pAlt = poissonCdf(Math.floor(cizgi), g.lh + g.la);
      const kod = Math.round(cizgi * 10);
      ekle("Alt/Üst", "alt" + kod, virgul(cizgi) + " Alt", o[0], qa[0], pAlt);
      ekle("Alt/Üst", "ust" + kod, virgul(cizgi) + " Üst", o[1], qa[1], pAlt != null ? 1 - pAlt : null);
    });
  });
  return liste;
}

/* ---------------- Kupon şablonları ---------------- */
const SLOTLAR = [
  { slot: 1, tur: "guvenli", label: "Kupon 1 · Güvenli", n: [2], min: 1.6, max: 2.4, minPick: 1.25, maxPick: 1.6 },
  { slot: 2, tur: "dengeli", label: "Kupon 2 · Dengeli", n: [2, 3], min: 3.5, max: 4.5, minPick: 1.45, maxPick: 2.6 },
  { slot: 3, tur: "dengeli", label: "Kupon 3 · Dengeli", n: [2, 3], min: 3.5, max: 4.5, minPick: 1.45, maxPick: 2.6, farkliMac: true },
  { slot: 4, tur: "tekli", label: "Kupon 4 · Günün seçimi", n: [1], min: 1.5, max: 2.5, minPick: 1.5, maxPick: 2.5 },
  { slot: 5, tur: "riskli", label: "Kupon 5 · Riskli", n: [3, 4], min: 8, max: 20, minPick: 1.9, maxPick: 3.2 }
];

const carp = (picks) => picks.reduce((a, c) => a * c.odd, 1);
const skorHesap = (c) => Math.log(Math.max(c.p, 1e-6)) + (c.uyum ? 0.05 : 0) + (c.deger ? Math.log(c.deger) : 0);

// Havuzdan, tek maçtan en fazla bir seçim olacak şekilde, hedef oran aralığındaki en olası kombinasyonu bulur
function enIyiKombine(havuz, cfg, haric = new Set()) {
  // Havuz: bu kupon türünün oran aralığındaki seçimler; her maçtan en iyi 2'si, toplamda en iyi 40'ı
  const maca = new Map();
  havuz
    .filter((c) => c.odd >= (cfg.minPick || 0) && (!cfg.maxPick || c.odd <= cfg.maxPick) && !haric.has(c.matchId))
    .sort((a, b) => skorHesap(b) - skorHesap(a))
    .forEach((c) => { const l = maca.get(c.matchId) || []; if (l.length < 2) { l.push(c); maca.set(c.matchId, l); } });
  const pool = [...maca.values()].flat().sort((a, b) => skorHesap(b) - skorHesap(a)).slice(0, 40);
  let en = null;
  for (const n of cfg.n) {
    const yigin = [];
    const gez = (bas, oran, skor) => {
      if (yigin.length === n) {
        if (oran >= cfg.min && oran <= cfg.max && yigin.every((c) => c.mbs <= n)) {
          if (!en || skor > en.skor) en = { picks: yigin.slice(), skor };
        }
        return;
      }
      for (let i = bas; i < pool.length; i++) {
        const c = pool[i];
        if (yigin.some((y) => y.matchId === c.matchId)) continue;
        if (oran * c.odd > cfg.max) continue;
        yigin.push(c);
        gez(i + 1, oran * c.odd, skor + skorHesap(c));
        yigin.pop();
      }
    };
    gez(0, 1, 0);
  }
  return en && en.picks;
}

const sablonGerekce = (c) => {
  const a = c.pA != null ? `API-Football ${Math.round(c.pA * 100)}%, ` : "";
  return `Piyasa olasılığı %${Math.round(c.pM * 100)}, ${a}birleşik tahmin %${Math.round(c.p * 100)}.` +
    (c.pA == null ? " Bu maç için ikinci kaynak yok." : c.uyum ? " İki kaynak aynı yönde." : " İki kaynak arasında fark var.") +
    (c.deger ? ` Nesine fiyatı Bet365 ile ortalamaya göre ${c.deger >= 1 ? "cömert" : "dar"} (değer ${c.deger.toFixed(2)}).` : "");
};
const sablonRisk = (c) => `Tek seçimin tutma olasılığı yaklaşık %${Math.round(c.p * 100)}; kuponda diğer seçimlerle çarpılır.`;

// 5 kuponu kural tabanlı kurar. Kuramadığı slotu atlar.
function kuralKuponlari(adaylar) {
  const sonuc = [];
  const kullanilanDengeli = new Set();
  for (const cfg of SLOTLAR) {
    let secim = null;
    if (cfg.farkliMac) secim = enIyiKombine(adaylar, cfg, kullanilanDengeli);
    if (!secim) secim = enIyiKombine(adaylar, cfg);
    if (!secim) continue;
    if (cfg.tur === "dengeli" && !cfg.farkliMac) secim.forEach((c) => kullanilanDengeli.add(c.matchId));
    sonuc.push({
      slot: cfg.slot, label: cfg.label, tur: cfg.tur, method: "kural",
      picks: secim.map((c) => ({ id: c.id, reason: sablonGerekce(c), risk: sablonRisk(c) }))
    });
  }
  return sonuc;
}

/* ---------------- Doğrulama ve belgeye çevirme ---------------- */
// taslak: { slot, picks:[{id,reason,risk}] } -> { ok, hata, picks:[aday+reason+risk], totalOdd }
function kuponDogrula(taslak, byId) {
  const cfg = SLOTLAR.find((s) => s.slot === taslak.slot);
  if (!cfg) return { ok: false, hata: "bilinmeyen slot" };
  const picks = [];
  for (const p of taslak.picks || []) {
    const c = byId.get(p.id);
    if (!c) return { ok: false, hata: "listede olmayan seçim: " + p.id };
    picks.push({ ...c, reason: String(p.reason || "").slice(0, 400), risk: String(p.risk || "").slice(0, 300) });
  }
  if (!cfg.n.includes(picks.length)) return { ok: false, hata: "seçim sayısı uygun değil" };
  if (new Set(picks.map((c) => c.matchId)).size !== picks.length) return { ok: false, hata: "aynı maçtan birden fazla seçim" };
  if (picks.some((c) => c.mbs > picks.length)) return { ok: false, hata: "MBS kuralı sağlanmıyor" };
  if (cfg.maxPick && picks.some((c) => c.odd > cfg.maxPick)) return { ok: false, hata: "tek seçim oranı çok yüksek" };
  const toplam = carp(picks);
  if (toplam < cfg.min || toplam > cfg.max) return { ok: false, hata: `toplam oran ${toplam.toFixed(2)} aralık dışı` };
  return { ok: true, picks, totalOdd: yuvarla(toplam, 2), cfg };
}

function pickBelgesi(c) {
  return {
    matchId: c.matchId, t: c.t, h: c.h, a: c.a, lg: c.lg, market: c.market, pick: c.pick, pickLabel: c.pickLabel,
    odd: c.odd, prob: c.p, probMarket: c.pM, probApi: c.pA, probBet365: c.pB, deger: c.deger, reason: c.reason || "", risk: c.risk || "", result: null
  };
}

/* ---------------- Claude istemi ---------------- */
function claudeIstemi(adaylar, notlar = "") {
  const satirlar = adaylar.map((c) => JSON.stringify({
    id: c.id, saat: c.t, lig: c.lg, mac: `${c.h} - ${c.a}`, secim: c.pickLabel, oran: c.odd,
    pPiyasa: c.pM, pAPI: c.pA, p: c.p, deger: c.deger == null ? undefined : c.deger, mbs: c.mbs,
    form: c.ek && c.ek.form ? `${c.ek.form.home || "-"} / ${c.ek.form.away || "-"}` : undefined,
    sakat: c.ek && c.ek.sakat ? `${c.ek.sakat.h}/${c.ek.sakat.a}` : undefined
  })).join("\n");
  const sistem = "Sen bir futbol kuponu analistisin. Sadece sana verilen aday listesinden seçim yaparsın. " +
    "Listedeki sayıların dışında haber, sakatlık, rotasyon, takım bilgisi UYDURMAZSIN. Gerekçeler Türkçe, kısa ve sayılara dayalı olur. " +
    "Kazanç garantisi vermezsin; riski dürüstçe yazarsın. Çıktın yalnızca geçerli JSON olur.";
  const kullanici = `Bugünün aday seçimleri (her satır bir seçim; p = piyasa ve API-Football olasılığının birleşimi, pAPI boşsa ikinci kaynak yok;
deger = Nesine oranı x (Nesine+Bet365) ortalama olasılığı, sadece MS ve çifte şansta var: 1'in üstü Nesine fiyatının ortalamaya göre cömert olduğunu gösterir, kârlılık garantisi değildir):
${satirlar}
${notlar}

Tam 5 kupon kur:
1) "Güvenli": 2 seçim, toplam oran 1,60-2,40, her seçim oranı en fazla 1,60.
2) "Dengeli A": 2 veya 3 seçim, toplam oran 3,50-4,50, her seçim oranı en fazla 2,60.
3) "Dengeli B": 2 veya 3 seçim, toplam oran 3,50-4,50, mümkünse Dengeli A'dan farklı maçlar.
4) "Günün seçimi": tek seçim, oran 1,50-2,50.
5) "Riskli": 3 veya 4 seçim, toplam oran 8-20, her seçim oranı en fazla 3,20.

Kurallar:
- Bir kuponda aynı maçtan en fazla bir seçim.
- Her seçimin mbs değeri, kuponun seçim sayısından büyük olamaz (örn. mbs 3 olan maç en az 3 seçimli kuponda olur).
- Yüksek p'li, iki kaynağın (pPiyasa ve pAPI) uyumlu olduğu seçimleri tercih et; iki kaynak çok ayrışıyorsa nedenini riskte belirt.
- Olasılıkları benzer iki seçim arasında "deger" değeri yüksek olanı tercih et (varsa).
- Her seçim için "reason" (en fazla 2 kısa cümle, verilen sayılara dayalı) ve "risk" (1 cümle) yaz.
- Sadece aday listesindeki "id" değerlerini kullan.

Yalnızca şu biçimde JSON döndür:
{"kuponlar":[{"slot":1,"picks":[{"id":"...","reason":"...","risk":"..."}]},{"slot":2,...},{"slot":3,...},{"slot":4,...},{"slot":5,...}]}`;
  return { sistem, kullanici };
}

function claudeCevabiniOku(metin) {
  const bas = metin.indexOf("{"), son = metin.lastIndexOf("}");
  if (bas < 0 || son < bas) throw new Error("Claude yanıtında JSON bulunamadı");
  const j = JSON.parse(metin.slice(bas, son + 1));
  if (!Array.isArray(j.kuponlar)) throw new Error("Claude yanıtında 'kuponlar' yok");
  return j.kuponlar;
}

/* ---------------- Sonuç hesabı ---------------- */
const BITMIS = ["FT", "AET", "PEN"];
const IPTAL = ["PST", "CANC", "ABD", "AWD", "WO", "SUSP", "INT"];

// fix: API-Football fixture nesnesi (ham /fixtures yanıtı). 90 dakika skoru kullanılır.
function skorlar(fix) {
  const ft = fix.score && fix.score.fulltime && fix.score.fulltime.home != null ? fix.score.fulltime : fix.goals;
  const ht = fix.score && fix.score.halftime ? fix.score.halftime : null;
  return { h: ft ? ft.home : null, a: ft ? ft.away : null, hh: ht ? ht.home : null, ha: ht ? ht.away : null };
}
// döner: "won" | "lost" | "void" | null (henüz belli değil)
function pickSonucu(pick, fix) {
  const durum = fix.fixture && fix.fixture.status && fix.fixture.status.short;
  if (IPTAL.includes(durum)) return "void";
  if (!BITMIS.includes(durum)) return null;
  const s = skorlar(fix);
  if (s.h == null || s.a == null) return null;
  const top = s.h + s.a;
  let k;
  switch (pick) {
    case "1": k = s.h > s.a; break;
    case "X": k = s.h === s.a; break;
    case "2": k = s.h < s.a; break;
    case "cs1x": k = s.h >= s.a; break;
    case "cs12": k = s.h !== s.a; break;
    case "csx2": k = s.h <= s.a; break;
    case "kgvar": k = s.h > 0 && s.a > 0; break;
    case "kgyok": k = !(s.h > 0 && s.a > 0); break;
    default: {
      const m = /^(alt|ust)(\d+)$/.exec(pick);
      if (!m) return null;
      const cizgi = Number(m[2]) / 10;
      k = m[1] === "alt" ? top < cizgi : top > cizgi;
    }
  }
  return k ? "won" : "lost";
}
// picks[].result'tan kupon durumu
function kuponDurumu(picks) {
  if (picks.some((p) => p.result === "lost")) return "lost";
  if (picks.some((p) => p.result == null)) return "open";
  const gecerli = picks.filter((p) => p.result === "won");
  return gecerli.length ? "won" : "void";
}
const gecerliOran = (picks) => yuvarla(picks.filter((p) => p.result !== "void").reduce((a, p) => a * p.odd, 1), 2);

module.exports = {
  TZ, trTarih, trHM, dk, yuvarla, normalize, benzerlik, esle, marjsiz, poissonCdf, apiGorusu,
  adaylariUret, SLOTLAR, enIyiKombine, kuralKuponlari, kuponDogrula, pickBelgesi,
  claudeIstemi, claudeCevabiniOku, pickSonucu, kuponDurumu, gecerliOran, BITMIS, IPTAL
};
