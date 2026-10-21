"use strict";
// Maç sonucu kaynakları. Hepsi API-Football biçiminde (fixture/teams/goals/score) normalize edilir,
// böylece kupon-motoru.cjs içindeki pickSonucu / esle aynen çalışır.
//
// Sıra: 1) API-Football (anahtar çalışıyorsa)  2) ESPN herkese açık skor tablosu  3) TheSportsDB (ücretsiz anahtar "3")
// Tek kaynak hata verirse sıradakine geçilir; engel/askı gibi durumlarda aşmaya çalışılmaz, sadece diğer kaynağa bakılır.

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tekrar = 1) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "ortak-kupon-private-tracker/1.0", Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    if (tekrar > 0) { await bekle(3000); return getJson(url, tekrar - 1); }
    throw e;
  }
}

const gunEkle = (gun, n) => { const d = new Date(gun + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function fix(dateIso, home, away, durum, h, a) {
  const var_ = h != null && a != null;
  return {
    fixture: { date: dateIso, status: { short: durum } },
    teams: { home: { name: home }, away: { name: away } },
    goals: { home: var_ ? h : null, away: var_ ? a : null },
    score: { fulltime: { home: var_ ? h : null, away: var_ ? a : null }, halftime: { home: null, away: null } },
    _kaynak: true
  };
}

/* ------------------------- ESPN ------------------------- */
const ESPN_LIGLER = [
  "tur.1", "tur.2", "eng.1", "eng.2", "eng.3", "esp.1", "esp.2", "ger.1", "ger.2", "ita.1", "ita.2", "fra.1", "fra.2",
  "ned.1", "por.1", "bel.1", "sco.1", "aut.1", "sui.1", "gre.1", "rus.1", "den.1", "swe.1", "nor.1",
  "uefa.champions", "uefa.europa", "uefa.europa.conf", "usa.1", "bra.1", "arg.1", "mex.1", "jpn.1"
];
function espnDurum(t) {
  const ad = String((t && t.name) || "");
  if (/POSTPONED|CANCEL|ABANDON|SUSPEND|FORFEIT|DELAYED/i.test(ad)) return "PST";
  if (t && t.completed) return "FT";
  if (/FULL_TIME|FINAL/i.test(ad)) return "FT";
  return "NS";
}
async function espnGun(gun) {
  const sonuc = [];
  const tarihler = [gunEkle(gun, -1), gun, gunEkle(gun, 1)].map((g) => g.replace(/-/g, ""));
  let basarili = 0;
  for (const lig of ESPN_LIGLER) {
    for (const t of tarihler) {
      try {
        const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lig}/scoreboard?dates=${t}`, 0);
        basarili++;
        (j.events || []).forEach((e) => {
          const c = e.competitions && e.competitions[0];
          if (!c) return;
          const ev = (c.competitors || []).find((x) => x.homeAway === "home"), dep = (c.competitors || []).find((x) => x.homeAway === "away");
          if (!ev || !dep) return;
          const durum = espnDurum((c.status || e.status || {}).type);
          const sk = (x) => (x.score === undefined || x.score === "" ? null : Number(x.score));
          sonuc.push(fix(e.date, ev.team.displayName || ev.team.name, dep.team.displayName || dep.team.name, durum, durum === "FT" ? sk(ev) : null, durum === "FT" ? sk(dep) : null));
        });
      } catch (e) { /* lig/tarih yoksa geç */ }
    }
    await bekle(120);
  }
  if (!basarili) throw new Error("ESPN'den hiç yanıt alınamadı");
  return sonuc;
}

/* ------------------------- TheSportsDB ------------------------- */
function tsdbDurum(s) {
  const t = String(s || "");
  if (/postpon|cancel|abandon|suspend|interrupt|walkover|awarded/i.test(t)) return "PST";
  if (/finish|^ft$|full|after|aet|pen/i.test(t)) return "FT";
  return "NS";
}
function tsdbTarih(e) {
  if (e.strTimestamp) return /Z|[+-]\d\d:?\d\d$/.test(e.strTimestamp) ? e.strTimestamp : e.strTimestamp + "Z";
  if (e.dateEvent) return `${e.dateEvent}T${(e.strTime || "00:00:00").slice(0, 8)}Z`;
  return null;
}
async function tsdbGun(gun) {
  const sonuc = [];
  let basarili = 0;
  for (const g of [gunEkle(gun, -1), gun, gunEkle(gun, 1)]) {
    try {
      const j = await getJson(`https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${g}&s=Soccer`, 1);
      basarili++;
      (j.events || []).forEach((e) => {
        const tarih = tsdbTarih(e);
        if (!tarih || !e.strHomeTeam || !e.strAwayTeam) return;
        const durum = tsdbDurum(e.strStatus);
        const sk = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
        sonuc.push(fix(tarih, e.strHomeTeam, e.strAwayTeam, durum, durum === "FT" ? sk(e.intHomeScore) : null, durum === "FT" ? sk(e.intAwayScore) : null));
      });
    } catch (e) { /* sıradaki gün */ }
    await bekle(2200);   // ücretsiz anahtar: dakikada ~30 istek
  }
  if (!basarili) throw new Error("TheSportsDB'den hiç yanıt alınamadı");
  return sonuc;
}

/* ------------------------- ana giriş ------------------------- */
// apiFootballGet: (gun) => fixture listesi (hata verirse throw eder)
async function gunMaclari(gun, apiFootballGet) {
  const hatalar = [];
  const kaynak = (process.env.SONUC_KAYNAK || "auto").toLowerCase();
  if ((kaynak === "auto" || kaynak === "apifootball") && apiFootballGet) {
    try {
      const l = await apiFootballGet(gun);
      if (l.length) return { kaynak: "API-Football", liste: l, hatalar };
      hatalar.push("API-Football: boş liste");
    } catch (e) { hatalar.push("API-Football: " + e.message); }
  }
  if (kaynak === "apifootball") return { kaynak: null, liste: [], hatalar };
  const toplam = []; const kullanilan = [];
  for (const [ad, fn] of [["ESPN", espnGun], ["TheSportsDB", tsdbGun]]) {
    try {
      const l = await fn(gun);
      console.log(`  ${ad}: ${l.length} maç (${l.filter((x) => x.fixture.status.short === "FT").length} bitmiş)`);
      if (l.length) { toplam.push(...l); kullanilan.push(ad); }
    } catch (e) { hatalar.push(ad + ": " + e.message); }
  }
  return { kaynak: kullanilan.join("+") || null, liste: toplam, hatalar };
}

module.exports = { gunMaclari, espnDurum, tsdbDurum, tsdbTarih, fix };
