// Açık AI kuponlarını bitmiş maç skorlarıyla sonuçlandırır (her gece).
// Her tarih için API-Football'a tek istek atar: /fixtures?date=...  (tüm dünyadaki maçlar, 90 dk skoru).
//
// Kurallar: biri yatarsa kupon hemen "Yattı"; iptal/ertelenen seçim "iptal" sayılır (oran 1,00);
// hepsi tutarsa "Tuttu"; hiçbiri geçerli değilse "İptal". 4 gün sonra hâlâ bulunamayan seçim iptal edilir.
//
// Ortam değişkenleri: FIREBASE_SERVICE_ACCOUNT, API_FOOTBALL_KEY

const admin = require("firebase-admin");
const M = require("./kupon-motoru.cjs");
const K = require("./sonuc-kaynaklari.cjs");

const API_KEY = process.env.API_FOOTBALL_KEY;
const VAZGEC_GUN = 4;

async function apiGet(path, tekrar = 2) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, { headers: { "x-apisports-key": API_KEY } });
  if (res.status === 429 && tekrar > 0) { await new Promise((r) => setTimeout(r, 15000)); return apiGet(path, tekrar - 1); }
  if (!res.ok) throw new Error(`API hatası ${res.status}: ${path}`);
  const j = await res.json();
  // API-Football hata durumunda da 200 döner: errors dolu, response boş (günlük limit, plan, anahtar sorunu vb.)
  const hata = j.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length);
  if (hata) throw new Error("API-Football: " + JSON.stringify(j.errors).slice(0, 250));
  return j.response || [];
}

const gunFarki = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// Bir kuponun seçimlerini günceller; değişiklik özetini döner
function kuponuIsle(kupon, fixtureler, bugun) {
  const apiListe = fixtureler.map((f) => ({ date: f.fixture.date, home: f.teams.home.name, away: f.teams.away.name, _fix: f }));
  const bekleyen = kupon.picks.filter((p) => p.result == null);
  const liste = bekleyen.map((p) => ({ id: p.matchId, t: p.t, h: p.h, a: p.a }));
  const eslesen = M.esle(liste, apiListe);
  // Eşleşmeyenleri daha geniş saat toleransıyla (Nesine saati kaymış/ertelenmiş olabilir) tekrar dene
  const kalan = liste.filter((n) => !eslesen.has(n.id));
  if (kalan.length) {
    const kullanilan = new Set(eslesen.values());
    const ikinci = M.esle(kalan, apiListe.filter((a) => !kullanilan.has(a)), 240);
    ikinci.forEach((v, k) => eslesen.set(k, v));
  }
  // Tanı: hâlâ bulunamayanlar için en yakın aday
  liste.filter((n) => !eslesen.has(n.id)).forEach((n) => {
    let en = null, skor = 0;
    apiListe.forEach((a) => { const sk = (M.benzerlik(n.h, a.home) + M.benzerlik(n.a, a.away)) / 2; if (sk > skor) { skor = sk; en = a; } });
    console.log(`  ? bulunamadı: ${n.t} ${n.h} - ${n.a}` + (en ? `  | en yakın: ${en.home} - ${en.away} (benzerlik ${skor.toFixed(2)})` : ""));
  });
  let degisti = false;
  const picks = kupon.picks.map((p) => {
    if (p.result != null) return p;
    const e = eslesen.get(p.matchId);
    if (e) {
      const s = M.pickSonucu(p.pick, e._fix);
      if (s) { degisti = true; return { ...p, result: s }; }
      console.log(`  … henüz bitmedi: ${p.h} - ${p.a} (durum ${e._fix.fixture && e._fix.fixture.status && e._fix.fixture.status.short})`);
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
    // TEKRAR=true: son 10 günde "Sonuç bulunamadı" diye iptal edilmiş seçimleri yeniden çözmeyi dene
    if (process.env.TEKRAR === "true") {
      const sinir = M.trTarih(Date.now() - 10 * 864e5);
      const eski = await db.collection("aiCoupons").where("dateKey", ">=", sinir).get();
      for (const d of eski.docs) {
        const k = d.data();
        if (k.status === "open" || !(k.picks || []).some((p) => p.note === "Sonuç bulunamadı")) continue;
        const picks = k.picks.map((p) => { if (p.note !== "Sonuç bulunamadı") return p; const { note, ...kalan } = p; return { ...kalan, result: null }; });
        await d.ref.update({ picks, status: M.kuponDurumu(picks) });
        console.log(d.id, "yeniden değerlendirmeye alındı");
      }
    }
    const snap = await db.collection("aiCoupons").where("status", "==", "open").get();
    const gunler = {};
    snap.docs.forEach((d) => { const k = { id: d.id, ...d.data() }; if (k.dateKey <= bugun) (gunler[k.dateKey] = gunler[k.dateKey] || []).push(k); });
    let guncellenen = 0;
    const kaynaklar = new Set();
    for (const gun of Object.keys(gunler).sort()) {
      const { kaynak, liste: fixtureler, hatalar } = await K.gunMaclari(gun, (g) => apiGet(`/fixtures?date=${g}&timezone=Europe/Istanbul`));
      hatalar.forEach((h) => console.log("  uyarı:", h));
      console.log(gun, fixtureler.length, "maç alındı (kaynak:", kaynak || "yok", "),", gunler[gun].length, "açık kupon");
      if (fixtureler.length === 0) throw new Error(`${gun} için hiçbir kaynaktan maç alınamadı: ${hatalar.join(" | ")}`.slice(0, 280));
      kaynaklar.add(kaynak);
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
    const acikKalan = Object.keys(gunler).reduce((t, g) => t + gunler[g].length, 0) - guncellenen;
    console.log(`Bitti: ${guncellenen} kupon güncellendi, ${Math.max(0, acikKalan)} kupon hâlâ açık`);
    await durumRef.set({ lastSettle: new Date().toISOString(), settleOk: true, settleMessage: `${guncellenen} kupon güncellendi` + (kaynaklar.size ? ` (kaynak: ${[...kaynaklar].join(", ")})` : "") + (acikKalan > 0 ? `, ${acikKalan} kupon henüz sonuçlanmadı (maçlar bitmemiş ya da eşleşmedi)` : "") }, { merge: true });
  } catch (e) {
    console.error("HATA:", e.message);
    await durumRef.set({ lastSettle: new Date().toISOString(), settleOk: false, settleMessage: String(e.message).slice(0, 300) }, { merge: true });
    process.exitCode = 1;
  }
}

if (require.main === module) main(); else module.exports = { kuponuIsle };
