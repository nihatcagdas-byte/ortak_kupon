// Nesine bülteni -> Firestore (bulten/{YYYY-MM-DD}). Günde 1 kez GitHub Actions çalıştırır.
//
// Sınırlar (bilerek): giriş yok, tek istek, engel varsa (403/429) tekrar denemez ve
// engeli aşmaya çalışmaz; sadece panodaki durum satırına nedenini yazar.
// Gerekli ortam değişkeni: FIREBASE_SERVICE_ACCOUNT (mevcut GitHub Secret).

const admin = require("firebase-admin");

const FEED = "https://cdnbulten.nesine.com/api/bulten/getprebultenfull";
const GUN_SAYISI = 2;      // bugün + yarın
const SAKLA_GUN = 3;       // bundan eski bulten belgeleri silinir
const TZ = "Europe/Istanbul";

const AD = { 1: "ms", 3: "cs", 38: "kg", 5: "iyms", 43: "tga" };
const AU_CIZGILER = [1.5, 2.5, 3.5];

const trTarih = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));
const bul = (d) => d.split(".").reverse().join("-"); // 10.10.2026 -> 2026-10-10

function paketle(e, lig) {
  const m = {};
  (e.MA || []).forEach((x) => {
    let k;
    if (x.MTID === 12) {
      if (!AU_CIZGILER.includes(x.SOV)) return;
      k = "au" + String(x.SOV).replace(".", "");
    } else k = AD[x.MTID];
    if (!k) return;
    m[k] = (x.OCA || []).slice().sort((a, b) => a.N - b.N).map((c) => c.O);
  });
  return { id: e.C, t: e.T, h: e.HN, a: e.AN, lg: lig[e.LC] || "Lig " + e.LC, mbs: e.EMBS || 1, m };
}

function cevir(j) {
  const sg = j.sg;
  const lig = {};
  (sg.LA || []).forEach((l) => { lig[l.LID] = l.N; });
  const gunler = {};
  (sg.EA || [])
    .filter((e) => e.GT === 1 && e.TYPE === 1 && e.MA && e.MA.length && e.HN && e.AN)
    .forEach((e) => { (gunler[bul(e.D)] = gunler[bul(e.D)] || []).push(paketle(e, lig)); });
  Object.values(gunler).forEach((a) => a.sort((x, y) => x.t.localeCompare(y.t)));
  return gunler;
}

async function indir() {
  const dene = async () => {
    const res = await fetch(FEED, {
      headers: { "User-Agent": "ortak-kupon-private-tracker/1.0 (gunde 1 istek)", Accept: "application/json" },
    });
    if (res.status === 403 || res.status === 429) {
      const e = new Error("Nesine isteği reddetti (HTTP " + res.status + "). Engeli aşmaya çalışılmadı.");
      e.durdur = true;
      throw e;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  };
  try {
    return await dene();
  } catch (e) {
    if (e.durdur) throw e;
    await new Promise((r) => setTimeout(r, 60000)); // ağ/5xx için tek tekrar
    return dene();
  }
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const col = db.collection("bulten");
  const simdi = new Date().toISOString();

  try {
    const gunler = cevir(await indir());
    const bugun = trTarih(Date.now());
    const secilen = Object.keys(gunler).filter((d) => d >= bugun).sort().slice(0, GUN_SAYISI);
    if (!secilen.length) throw new Error("Bültende bugün veya sonrası için futbol maçı bulunamadı.");

    for (const d of secilen) {
      await col.doc(d).set({ json: JSON.stringify(gunler[d]), count: gunler[d].length, updatedAt: simdi, source: "nesine" });
      console.log(d, gunler[d].length, "mac yazildi");
    }

    // eski günleri temizle
    const sinir = trTarih(Date.now() - SAKLA_GUN * 864e5);
    for (const ref of await col.listDocuments()) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(ref.id) && ref.id < sinir) await ref.delete();
    }
    await col.doc("status").set({ ok: true, lastRun: simdi, message: secilen.map((d) => d + ": " + gunler[d].length).join(", ") });
  } catch (e) {
    console.error("HATA:", e.message);
    await col.doc("status").set({ ok: false, lastRun: simdi, message: String(e.message).slice(0, 300) });
    process.exitCode = 1;
  }
}

if (require.main === module) main(); else module.exports = { cevir };
