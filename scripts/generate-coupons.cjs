// Günün 3 AI kuponunu (Güvenli / Orta / Riskli) üretir ve Firestore'a (aiCoupons/{tarih}_{sıra}) yazar.
//
// Akış: bulten/{bugün} (Nesine) + liveMatches/{bugün} (API-Football) -> aday seçimler ->
//       Claude 3 kuponu seçer ve gerekçe yazar -> sunucu doğrular (oran, MBS, tek maç) ->
//       geçersiz/eksik kuponlar kural tabanlı kuponla değiştirilir -> yazılır.
//
// Ortam değişkenleri:
//   FIREBASE_SERVICE_ACCOUNT (zorunlu)   ANTHROPIC_API_KEY (yoksa sadece kural kullanılır)
//   ANTHROPIC_MODEL (varsayılan claude-sonnet-5-5)   FORCE=1 (bugünün kuponlarını yeniden yazar)

const admin = require("firebase-admin");
const M = require("./kupon-motoru.cjs");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_BULTEN_YAS_SAAT = 6; // bülten bundan eskiyse kupon üretilmez (eski oranlar)

async function claudeKuponlari(adaylar, anahtar, fetchImpl = fetch, notlar = "") {
  const { sistem, kullanici } = M.claudeIstemi(adaylar, notlar);
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": anahtar, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, system: sistem, messages: [{ role: "user", content: kullanici }] })
  });
  if (!res.ok) throw new Error("Claude API " + res.status + ": " + (await res.text()).slice(0, 200));
  const j = await res.json();
  const metin = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return M.claudeCevabiniOku(metin);
}

// Claude taslaklarını doğrular; geçersiz slotları kural tabanlı kuponla doldurur.
// Kuponlar mümkün olduğunca farklı maçlardan oluşur (Claude'un çakışan önerisi reddedilir, kural kuponu kurulur).
function birlestir(adaylar, claudeTaslak) {
  const byId = new Map(adaylar.map((c) => [c.id, c]));
  const sonuc = [], notlar = [];
  const imza = (picks) => picks.map((c) => c.id).sort().join(",");
  const kullanilan = new Set();
  const kullanilanMac = new Set();

  for (const cfg of M.SLOTLAR) {
    let secilen = null, method = "kural";
    const cl = claudeTaslak && claudeTaslak.find((k) => Number(k.slot) === cfg.slot);
    if (cl) {
      const v = M.kuponDogrula({ ...cl, slot: cfg.slot }, byId);
      if (!v.ok) notlar.push(`Kupon ${cfg.slot}: Claude önerisi reddedildi (${v.hata})`);
      else if (kullanilan.has(imza(v.picks))) notlar.push(`Kupon ${cfg.slot}: Claude önerisi başka bir kuponla aynı`);
      else if (v.picks.some((c) => kullanilanMac.has(c.matchId))) notlar.push(`Kupon ${cfg.slot}: Claude önerisi başka kuponla aynı maçı kullanıyor`);
      else { secilen = v; method = "claude"; }
    }
    if (!secilen) {
      const k = M.kuralKupon(adaylar, cfg, kullanilanMac);
      if (k) {
        const v = M.kuponDogrula(k, byId);
        if (v.ok && !kullanilan.has(imza(v.picks))) secilen = v;
      }
    }
    if (!secilen) { notlar.push(`Kupon ${cfg.slot}: kurulamadı`); continue; }
    kullanilan.add(imza(secilen.picks));
    secilen.picks.forEach((c) => kullanilanMac.add(c.matchId));
    sonuc.push({ slot: cfg.slot, label: cfg.label, tur: cfg.tur, method, totalOdd: secilen.totalOdd, picks: secilen.picks });
  }
  return { kuponlar: sonuc, notlar };
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const durumRef = db.collection("bulten").doc("aiStatus");
  const simdi = new Date();
  const bugun = M.trTarih(simdi.getTime());
  const force = process.env.FORCE === "1";
  const yaz = (ok, mesaj) => durumRef.set({ ok, lastRun: simdi.toISOString(), message: String(mesaj).slice(0, 400) });

  try {
    const mevcut = await db.collection("aiCoupons").doc(`${bugun}_1`).get();
    if (mevcut.exists && !force) { console.log("Bugünün kuponları zaten var, çıkılıyor."); return; }

    const bs = await db.collection("bulten").doc(bugun).get();
    if (!bs.exists) throw new Error("Bugünün Nesine bülteni yok (önce bülten çekilmeli).");
    const yas = (Date.now() - new Date(bs.data().updatedAt).getTime()) / 36e5;
    if (yas > MAX_BULTEN_YAS_SAAT && !force) throw new Error(`Bülten ${Math.round(yas)} saat önceki, eski oranlarla kupon üretilmedi.`);
    const bulten = JSON.parse(bs.data().json || "[]");

    const lm = await db.collection("liveMatches").doc(bugun).get();
    const api = lm.exists ? (lm.data().matches || []) : [];
    const eslesen = M.esle(bulten, api);
    // Bet365 oranları liveMatches ile aynı anda çekildi; ne kadar eski olduğunu öğren
    let b365Yas = null;
    if (lm.exists && lm.data().updatedAt && lm.data().updatedAt.toMillis) b365Yas = (Date.now() - lm.data().updatedAt.toMillis()) / 36e5;
    const adaylar = M.adaylariUret(bulten, eslesen, { simdiDk: M.dk(M.trHM(simdi)), b365YasSaat: b365Yas });
    const degerli = adaylar.filter((c) => c.deger != null).length;
    console.log(`${bulten.length} maç, ${eslesen.size} tanesi API-Football ile eşleşti, ${adaylar.length} aday seçim, ${degerli} tanesinde Bet365 çapraz kontrolü (veri yaşı: ${b365Yas == null ? "?" : Math.round(b365Yas) + " saat"}).`);
    const istemNotu = degerli
      ? `Not: Bet365 oranları yaklaşık ${b365Yas == null ? "?" : Math.round(b365Yas)} saat önce alındı; bu aradaki oran değişimi "deger" farkını yapay büyütmüş olabilir.`
      : "";
    if (adaylar.length < 12) throw new Error(`Yeterli aday seçim yok (${adaylar.length}). Günün maçları çoğunlukla başlamış olabilir.`);

    // Claude'a her kuponun oran aralığından en iyi adayları ver (düşük oranlı seçimler diğer bantları doldurmasın)
    const secilenIdler = new Set();
    const kisaListe = [];
    for (const cfg of M.SLOTLAR) {
      const maca = new Map();
      adaylar
        .filter((c) => c.odd >= cfg.minPick && c.odd <= cfg.maxPick)
        .sort((a, b) => M.skorHesap(b) - M.skorHesap(a))
        .forEach((c) => { const l = maca.get(c.matchId) || []; if (l.length < 2) { l.push(c); maca.set(c.matchId, l); } });
      [...maca.values()].flat().sort((a, b) => M.skorHesap(b) - M.skorHesap(a)).slice(0, 40).forEach((c) => {
        if (!secilenIdler.has(c.id)) { secilenIdler.add(c.id); kisaListe.push(c); }
      });
    }

    let taslak = null, claudeNot = "Claude kullanılmadı (ANTHROPIC_API_KEY yok).";
    if (process.env.ANTHROPIC_API_KEY) {
      try { taslak = await claudeKuponlari(kisaListe, process.env.ANTHROPIC_API_KEY, fetch, istemNotu); claudeNot = "Claude yanıt verdi."; }
      catch (e) { claudeNot = "Claude çağrısı başarısız, kural tabanlı kuponlar kullanıldı: " + e.message; console.error(claudeNot); }
    }
    // Doğrulama için tüm adaylar geçerli (Claude sadece kısa listeden seçmeli, ama kural katmanı hepsini kullanabilir)
    const { kuponlar, notlar } = birlestir(adaylar, taslak);
    if (!kuponlar.length) throw new Error("Hiç kupon kurulamadı. " + notlar.join(" | "));

    const olusturma = new Date().toISOString();
    for (const k of kuponlar) {
      const belge = {
        dateKey: bugun, slot: k.slot, label: k.label, tur: k.tur, method: k.method, status: "open", sema: M.SEMA,
        totalOdd: k.totalOdd, picks: k.picks.map(M.pickBelgesi),
        oddsSource: "Nesine", oddsAt: bs.data().updatedAt, createdAt: olusturma
      };
      const ref = db.collection("aiCoupons").doc(`${bugun}_${k.slot}`);
      if (force) await ref.set(belge); else await ref.create(belge);
      console.log(`Kupon ${k.slot} (${k.method}): ${k.picks.map((c) => c.h + " " + c.pickLabel).join(" + ")} = ${k.totalOdd}`);
    }
    if (force) {
      // eski 5 kuponluk düzenden kalan slotlar (4, 5) bugün için kaldırılır
      for (const eski of [4, 5]) {
        if (!M.SLOTLAR.some((c) => c.slot === eski)) await db.collection("aiCoupons").doc(`${bugun}_${eski}`).delete();
      }
    }
    await yaz(true, `${kuponlar.length} kupon (${kuponlar.map((k) => k.method).join(",")}). ${claudeNot} ${notlar.join(" | ")}`);
  } catch (e) {
    console.error("HATA:", e.message);
    await yaz(false, e.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main(); else module.exports = { claudeKuponlari, birlestir };
