// Açık AI kuponlarını bitmiş maç skorlarıyla sonuçlandırır (her gece).
// Her tarih için API-Football'a tek istek atar: /fixtures?date=...  (tüm dünyadaki maçlar, 90 dk skoru).
//
// Kurallar: biri yatarsa kupon hemen "Yattı"; iptal/ertelenen seçim "iptal" sayılır (oran 1,00);
// hepsi tutarsa "Tuttu"; hiçbiri geçerli değilse "İptal". 4 gün sonra hâlâ bulunamayan seçim iptal edilir.
//
// Ortam değişkenleri: FIREBASE_SERVICE_ACCOUNT, API_FOOTBALL_KEY

const admin = require("firebase-admin");
const M = require("./kupon-motoru.cjs");

const API_KEY = process.env.API_FOOTBALL_KEY;
const VAZGEC_GUN = 4;

async function apiGet(path, tekrar = 2) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, { headers: { "x-apisports-key": API_KEY } });
  if (res.status === 429 && tekrar > 0) { await new Promise((r) => setTimeout(r, 15000)); return apiGet(path, tekrar - 1); }
  if (!res.ok) throw new Error(`API hatası ${res.status}: ${path}`);
  const j = await res.json();
  return j.response || [];
}

const gunFarki = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// Bir kuponun seçimlerini günceller; değişiklik özetini döner
function kuponuIsle(kupon, fixtureler, bugun) {
  const apiListe = fixtureler.map((f) => ({ date: f.fixture.date, home: f.teams.home.name, away: f.teams.away.name, _fix: f }));
  const bekleyen = kupon.picks.filter((p) => p.result == null);
  const eslesen = M.esle(bekleyen.map((p) => ({ id: p.matchId, t: p.t, h: p.h, a: p.a })), apiListe);
  let degisti = false;
  const picks = kupon.picks.map((p) => {
    if (p.result != null) return p;
    const e = eslesen.get(p.matchId);
    if (e) {
      const s = M.pickSonucu(p.pick, e._fix);
      if (s) { degisti = true; return { ...p, result: s }; }
      return p;
    }
    if (gunFarki(kupon.dateKey, bugun) >= VAZGEC_GUN) { degisti = true; return { ...p, result: "void", note: "Sonuç bulunamadı" }; }
    return p;
  });
  const status = M.kuponDurumu(picks);
  return { degisti: degisti || status !== kupon.status, picks, status, settledOdd: M.gecerliOran(picks) };
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const bugun = M.trTarih(Date.now());
  const durumRef = db.collection("bulten").doc("aiStatus");
  try {
    const snap = await db.collection("aiCoupons").where("status", "==", "open").get();
    const gunler = {};
    snap.docs.forEach((d) => { const k = { id: d.id, ...d.data() }; if (k.dateKey <= bugun) (gunler[k.dateKey] = gunler[k.dateKey] || []).push(k); });
    let guncellenen = 0;
    for (const gun of Object.keys(gunler).sort()) {
      const fixtureler = await apiGet(`/fixtures?date=${gun}&timezone=Europe/Istanbul`);
      console.log(gun, fixtureler.length, "maç alındı,", gunler[gun].length, "açık kupon");
      for (const k of gunler[gun]) {
        const s = kuponuIsle(k, fixtureler, bugun);
        if (!s.degisti) continue;
        const guncelleme = { picks: s.picks, status: s.status };
        if (s.status === "won") guncelleme.settledOdd = s.settledOdd; // iptal seçimler çıkarılmış gerçek oran
        if (s.status !== "open") guncelleme.settledAt = new Date().toISOString();
        await db.collection("aiCoupons").doc(k.id).update(guncelleme);
        guncellenen++;
        console.log(k.id, "->", s.status);
      }
    }
    await durumRef.set({ lastSettle: new Date().toISOString(), settleOk: true, settleMessage: `${guncellenen} kupon güncellendi` }, { merge: true });
  } catch (e) {
    console.error("HATA:", e.message);
    await durumRef.set({ lastSettle: new Date().toISOString(), settleOk: false, settleMessage: String(e.message).slice(0, 300) }, { merge: true });
    process.exitCode = 1;
  }
}

if (require.main === module) main(); else module.exports = { kuponuIsle };
