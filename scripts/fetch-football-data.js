// ============================================================
// GÜNLÜK MAÇ ÇEKME SCRIPTİ
// ============================================================
// GitHub Actions tarafından üç ayrı zamanlamayla çalıştırılır:
//   - 09:00 Türkiye saati → MODE=matches, BUGÜNÜN maç/istatistik verisi
//   - 12:00 Türkiye saati → MODE=matches, YARININ maç/istatistik verisi
//   - Salı 07:00 Türkiye saati → MODE=standings, haftalık puan durumu
//
// API-Football'dan takip edilen liglerdeki maçları + (varsa) oranları +
// istatistik/tahmin/sakatlık verisini çekip Firestore'a yazar. API anahtarı
// hiçbir zaman tarayıcıya gitmez, sadece burada GitHub Secrets içinde durur.
// "Dinlenme günü" bilgisi API'den DEĞİL, kendi geçmiş Firestore verimizden
// hesaplanır — bu yüzden ekstra API isteği harcamaz.
// ============================================================

const admin = require("firebase-admin");

const API_KEY = process.env.API_FOOTBALL_KEY;
const SERVICE_ACCOUNT_RAW = process.env.FIREBASE_SERVICE_ACCOUNT;
const TARGET_DAY = process.env.TARGET_DAY === "tomorrow" ? "tomorrow" : "today";
const MODE = process.env.MODE === "standings" ? "standings" : "matches";

if (!API_KEY) throw new Error("API_FOOTBALL_KEY tanımlı değil (GitHub Secret eksik).");
if (!SERVICE_ACCOUNT_RAW) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil (GitHub Secret eksik).");

const serviceAccount = JSON.parse(SERVICE_ACCOUNT_RAW);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Takip edilen ligler + büyük turnuvalar (API-Football lig ID'leri).
// NOT: Yeni eklenen turnuva ID'leri (Dünya Kupası, Euro, Copa America,
// Uluslar Ligi, Konferans Ligi) en yaygın bilinen ID'ler — bir tanesi
// hiç maç getirmezse api-football.com hesabınızdan "Leagues" araması
// yapıp doğru ID'yi bulup burada güncelleyebilirsiniz.
const LEAGUES = [
  { id: 203, name: "Süper Lig" },
  { id: 204, name: "1. Lig" },
  { id: 39, name: "Premier Lig" },
  { id: 140, name: "La Liga" },
  { id: 78, name: "Bundesliga" },
  { id: 135, name: "Serie A" },
  { id: 61, name: "Ligue 1" },
  { id: 88, name: "Eredivisie" },
  { id: 94, name: "Primeira Liga" },
  { id: 2, name: "Şampiyonlar Ligi" },
  { id: 3, name: "Avrupa Ligi" },
  { id: 848, name: "Konferans Ligi" },
  { id: 1, name: "Dünya Kupası" },
  { id: 4, name: "Avrupa Şampiyonası (Euro)" },
  { id: 9, name: "Copa America" },
  { id: 5, name: "Uluslar Ligi" },
  { id: 206, name: "Türkiye Kupası" },
  { id: 45, name: "FA Cup" },
  { id: 143, name: "Copa del Rey" },
  { id: 81, name: "DFB-Pokal" },
  { id: 137, name: "Coppa Italia" },
  { id: 66, name: "Coupe de France" }
];

const BOOKMAKER_ID = 8; // Bet365 — sadece referans amaçlı, resmi İddaa oranı değildir

function dateKeyIstanbul(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit"
  });
  return fmt.format(d); // "YYYY-MM-DD"
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// API-Football sezonları başlangıç yılıyla adlandırılır (örn. "2025" =
// Ağustos 2025 - Haziran 2026 sezonu). Temmuz'dan önce hâlâ önceki sezondayız.
function currentSeasonYear() {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return m >= 7 ? y : y - 1;
}

// Bir takımın bugünden önceki en son maçını, API'ye HİÇ istek atmadan,
// kendi geçmiş Firestore kayıtlarımızdan (liveMatches koleksiyonu) geriye
// doğru tarayarak bulur. Bu yüzden ilk günlerde veri boş çıkabilir —
// geçmiş biriktikçe otomatik dolar.
async function findRestDays(teamName, beforeDateKey, lookbackDays = 14) {
  const [y, m, d] = beforeDateKey.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  for (let i = 1; i <= lookbackDays; i++) {
    const check = new Date(base);
    check.setUTCDate(base.getUTCDate() - i);
    const key = `${check.getUTCFullYear()}-${String(check.getUTCMonth() + 1).padStart(2, "0")}-${String(check.getUTCDate()).padStart(2, "0")}`;
    try {
      const snap = await db.collection("liveMatches").doc(key).get();
      if (snap.exists) {
        const data = snap.data();
        const found = (data.matches || []).find(mm => mm.home === teamName || mm.away === teamName);
        if (found) return i;
      }
    } catch (err) {
      console.error(`Dinlenme günü sorgusu başarısız (${teamName}, ${key}):`, err.message);
    }
  }
  return null;
}

async function apiGet(path, retries = 2) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { "x-apisports-key": API_KEY }
  });
  if (res.status === 429 && retries > 0) {
    console.log(`429 alındı, 15sn bekleyip tekrar denenecek: ${path}`);
    await sleep(15000);
    return apiGet(path, retries - 1);
  }
  if (!res.ok) throw new Error(`API hatası ${res.status}: ${path}`);
  const json = await res.json();
  return json.response || [];
}

async function fetchStandings() {
  const season = currentSeasonYear();
  console.log(`Puan durumu çekiliyor, sezon: ${season}`);
  let okCount = 0;
  for (const league of LEAGUES) {
    try {
      const resp = await apiGet(`/standings?league=${league.id}&season=${season}`);
      const table = resp?.[0]?.league?.standings?.[0] || [];
      if (table.length === 0) {
        console.log(`[${league.name}] puan durumu boş (turnuva formatı olabilir).`);
      } else {
        await db.collection("standings").doc(String(league.id)).set({
          leagueId: league.id,
          leagueName: league.name,
          season,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          table: table.map(row => ({
            rank: row.rank,
            teamId: row.team.id,
            teamName: row.team.name,
            points: row.points,
            played: row.all.played,
            win: row.all.win,
            draw: row.all.draw,
            lose: row.all.lose,
            goalsDiff: row.goalsDiff,
            form: row.form || null
          }))
        });
        okCount++;
        console.log(`[${league.name}] puan durumu yazıldı (${table.length} takım).`);
      }
    } catch (err) {
      console.error(`Puan durumu çekilemedi (${league.name}):`, err.message);
    }
    await sleep(1500);
  }
  console.log(`Puan durumu tamamlandı: ${okCount}/${LEAGUES.length} lig yazıldı.`);
}

async function main() {
  if (MODE === "standings") {
    await fetchStandings();
    return;
  }

  const dateKey = dateKeyIstanbul(TARGET_DAY === "tomorrow" ? 1 : 0);
  console.log(`Hedef gün: ${TARGET_DAY} — Tarih: ${dateKey}`);

  const allFixtures = await apiGet(`/fixtures?date=${dateKey}`);
  const leagueIds = new Set(LEAGUES.map(l => l.id));
  const fixtures = allFixtures.filter(f => leagueIds.has(f.league.id));
  console.log(`${allFixtures.length} dünya genelinde maçtan ${fixtures.length} tanesi takip edilen liglerde/turnuvalarda.`);

  // Oranları sadece bugün maçı olan ligler için, lig bazında çek
  const oddsByFixture = {};
  for (const league of LEAGUES) {
    const hasMatch = fixtures.some(f => f.league.id === league.id);
    if (!hasMatch) continue;
    try {
      const oddsResp = await apiGet(`/odds?date=${dateKey}&league=${league.id}&bookmaker=${BOOKMAKER_ID}`);
      console.log(`[${league.name}] /odds yanıtı: ${oddsResp.length} kayıt`);
      oddsResp.forEach(entry => {
        const bookmaker = (entry.bookmakers || []).find(b => b.id === BOOKMAKER_ID) || (entry.bookmakers || [])[0];
        const market = bookmaker && bookmaker.bets && bookmaker.bets.find(b => b.name === "Match Winner");
        if (market) {
          const vals = {};
          market.values.forEach(v => { vals[v.value] = v.odd; });
          oddsByFixture[entry.fixture.id] = { home: vals.Home || null, draw: vals.Draw || null, away: vals.Away || null };
        }
      });
    } catch (err) {
      console.error(`Oran çekilemedi (${league.name}):`, err.message);
    }
    await sleep(1500); // dakikalık istek limitine takılmamak için bekle
  }

  // Her maç için istatistik/tahmin verisi çek (gol ortalaması, form, H2H,
  // kazanma yüzdeleri) — API-Football'ın /predictions uç noktası bunların
  // hepsini tek çağrıda veriyor, maç başına sadece 1 istek.
  const statsByFixture = {};
  for (const f of fixtures) {
    try {
      const predResp = await apiGet(`/predictions?fixture=${f.fixture.id}`);
      const p = predResp[0];
      if (!p) continue;

      const homeTeam = p.teams && p.teams.home;
      const awayTeam = p.teams && p.teams.away;

      statsByFixture[f.fixture.id] = {
        // Not: under_over / predicted goals alanları API'de işaret (+/-) anlamı
        // net dokümante edilmediği için kasıtlı olarak KULLANMIYORUZ — yanlış
        // yorumlanıp "alt" yerine "üst" gösterme riskini almıyoruz. Sadece
        // net/kesin olan gol ortalaması + kazanma yüzdesi + H2H + karşılaştırma veriliyor.
        advice: (p.predictions && p.predictions.advice) || null,
        winPercent: (p.predictions && p.predictions.percent) || null, // {home, draw, away}
        form: {
          home: (homeTeam && homeTeam.league && homeTeam.league.form) || null,
          away: (awayTeam && awayTeam.league && awayTeam.league.form) || null
        },
        // Ev sahibinin İÇ SAHA ortalaması, deplasmanın DEPLASMAN ortalaması —
        // genel ortalamadan daha isabetli, çünkü bu maçtaki gerçek konumlarını yansıtıyor.
        // Veri yoksa (bazı liglerde split kırılım eksik olabilir) genel ortalamaya düşer.
        goalsAvg: {
          homeFor: homeTeam?.league?.goals?.for?.average?.home ?? homeTeam?.league?.goals?.for?.average?.total ?? null,
          homeAgainst: homeTeam?.league?.goals?.against?.average?.home ?? homeTeam?.league?.goals?.against?.average?.total ?? null,
          awayFor: awayTeam?.league?.goals?.for?.average?.away ?? awayTeam?.league?.goals?.for?.average?.total ?? null,
          awayAgainst: awayTeam?.league?.goals?.against?.average?.away ?? awayTeam?.league?.goals?.against?.average?.total ?? null
        },
        // API-Football'ın kendi karşılaştırma modeli — hücum/savunma gücü, form,
        // gol verimliliği ve poisson dağılımı bazında iki takımı yüzdesel kıyaslıyor.
        // Bahis oranı DEĞİL, API'nin istatistiksel modeli (6 farklı algoritma).
        comparison: p.comparison ? {
          form: p.comparison.form || null,
          att: p.comparison.att || null,
          def: p.comparison.def || null,
          poisson: p.comparison.poisson_distribution || null,
          goals: p.comparison.goals || null,
          total: p.comparison.total || null
        } : null,
        h2h: (p.h2h || []).slice(0, 5).map(h => ({
          date: h.fixture.date,
          home: h.teams.home.name,
          away: h.teams.away.name,
          goalsHome: h.goals.home,
          goalsAway: h.goals.away
        }))
      };
    } catch (err) {
      console.error(`Tahmin/istatistik çekilemedi (fixture ${f.fixture.id}):`, err.message);
    }
    await sleep(1500); // dakikalık istek limitine takılmamak için bekle

    // Sakatlık/ceza listesi — bu uç nokta fixture bazlı, o maça özel kadro dışılar
    try {
      const injResp = await apiGet(`/injuries?fixture=${f.fixture.id}`);
      const home = [], away = [];
      injResp.forEach(inj => {
        const entry = {
          player: inj.player && inj.player.name,
          reason: (inj.player && inj.player.reason) || (inj.player && inj.player.type) || "Belirsiz"
        };
        if (inj.team && inj.team.id === f.teams.home.id) home.push(entry);
        else if (inj.team && inj.team.id === f.teams.away.id) away.push(entry);
      });
      if (!statsByFixture[f.fixture.id]) statsByFixture[f.fixture.id] = {};
      statsByFixture[f.fixture.id].injuries = {
        home: home.slice(0, 6),
        away: away.slice(0, 6)
      };
    } catch (err) {
      console.error(`Sakatlık listesi çekilemedi (fixture ${f.fixture.id}):`, err.message);
    }
    await sleep(1500);

    // Dinlenme günü — API'ye gitmez, kendi geçmiş verimizden hesaplanır (ücretsiz)
    try {
      const homeRest = await findRestDays(f.teams.home.name, dateKey);
      const awayRest = await findRestDays(f.teams.away.name, dateKey);
      if (!statsByFixture[f.fixture.id]) statsByFixture[f.fixture.id] = {};
      statsByFixture[f.fixture.id].restDays = { home: homeRest, away: awayRest };
    } catch (err) {
      console.error(`Dinlenme günü hesaplanamadı (fixture ${f.fixture.id}):`, err.message);
    }
  }
  console.log(`${Object.keys(statsByFixture).length}/${fixtures.length} maç için istatistik alındı.`);

  const matches = fixtures.map(f => ({
    fixtureId: f.fixture.id,
    league: f.league.name,
    leagueId: f.league.id,
    round: f.league.round || null,
    date: f.fixture.date,
    status: f.fixture.status.short,
    statusLong: f.fixture.status.long,
    elapsed: f.fixture.status.elapsed,
    home: f.teams.home.name,
    away: f.teams.away.name,
    homeId: f.teams.home.id,
    awayId: f.teams.away.id,
    homeLogo: f.teams.home.logo,
    awayLogo: f.teams.away.logo,
    goalsHome: f.goals.home,
    goalsAway: f.goals.away,
    odds: oddsByFixture[f.fixture.id] || null,
    stats: statsByFixture[f.fixture.id] || null
  }));

  // Ligine ve saatine göre sırala
  matches.sort((a, b) => a.league.localeCompare(b.league, "tr") || new Date(a.date) - new Date(b.date));

  await db.collection("liveMatches").doc(dateKey).set({
    dateKey,
    targetDay: TARGET_DAY,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    matchCount: matches.length,
    matches
  });

  console.log(`Firestore'a yazıldı (${dateKey}): ${matches.length} maç, ${Object.keys(oddsByFixture).length} maçta oran, ${Object.keys(statsByFixture).length} maçta istatistik var.`);
}

main().catch(err => {
  console.error("Script hata verdi:", err);
  process.exit(1);
});
