// ============================================================
// GÜNLÜK MAÇ + ORAN ÇEKME SCRIPTİ
// ============================================================
// Bu script GitHub Actions tarafından günde 2 kez (09:00 ve 12:00
// Türkiye saati) otomatik çalıştırılır. API-Football'dan o günün
// takip edilen liglerdeki maçlarını + oranlarını çekip Firestore'a
// yazar. Site (app.js) bu veriyi doğrudan Firestore'dan okur,
// API'ye hiç bağlanmaz — API anahtarı hiçbir zaman tarayıcıya gitmez.
// ============================================================

const admin = require("firebase-admin");

const API_KEY = process.env.API_FOOTBALL_KEY;
const SERVICE_ACCOUNT_RAW = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!API_KEY) throw new Error("API_FOOTBALL_KEY tanımlı değil (GitHub Secret eksik).");
if (!SERVICE_ACCOUNT_RAW) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil (GitHub Secret eksik).");

const serviceAccount = JSON.parse(SERVICE_ACCOUNT_RAW);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Takip edilen ligler (API-Football lig ID'leri). İstersen buraya
// yeni lig ekleyebilir/çıkarabilirsin — ID'leri api-football.com
// hesabından "Leagues" bölümünde arayarak bulabilirsin.
const LEAGUES = [
  { id: 203, name: "Süper Lig" },
  { id: 204, name: "1. Lig" },
  { id: 39, name: "Premier Lig" },
  { id: 140, name: "La Liga" },
  { id: 78, name: "Bundesliga" },
  { id: 135, name: "Serie A" },
  { id: 61, name: "Ligue 1" },
  { id: 2, name: "Şampiyonlar Ligi" },
  { id: 3, name: "Avrupa Ligi" }
];

const BOOKMAKER_ID = 8; // Bet365 — sadece referans amaçlı, resmi İddaa oranı değildir

function todayKeyIstanbul() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit"
  });
  return fmt.format(new Date()); // "YYYY-MM-DD"
}

async function apiGet(path) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { "x-apisports-key": API_KEY }
  });
  if (!res.ok) throw new Error(`API hatası ${res.status}: ${path}`);
  const json = await res.json();
  return json.response || [];
}

async function main() {
  const dateKey = todayKeyIstanbul();
  console.log("Tarih:", dateKey);

  const allFixtures = await apiGet(`/fixtures?date=${dateKey}`);
  const leagueIds = new Set(LEAGUES.map(l => l.id));
  const fixtures = allFixtures.filter(f => leagueIds.has(f.league.id));
  console.log(`${allFixtures.length} dünya genelinde maçtan ${fixtures.length} tanesi takip edilen liglerde.`);

  // Oranları sadece bugün maçı olan ligler için, lig bazında çek
  const oddsByFixture = {};
  for (const league of LEAGUES) {
    const hasMatch = fixtures.some(f => f.league.id === league.id);
    if (!hasMatch) continue;
    try {
      const oddsResp = await apiGet(`/odds?date=${dateKey}&league=${league.id}&bookmaker=${BOOKMAKER_ID}`);
      oddsResp.forEach(entry => {
        const bookmaker = (entry.bookmakers || [])[0];
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
  }

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
    homeLogo: f.teams.home.logo,
    awayLogo: f.teams.away.logo,
    goalsHome: f.goals.home,
    goalsAway: f.goals.away,
    odds: oddsByFixture[f.fixture.id] || null
  }));

  // Ligine ve saatine göre sırala
  matches.sort((a, b) => a.league.localeCompare(b.league, "tr") || new Date(a.date) - new Date(b.date));

  await db.collection("liveMatches").doc(dateKey).set({
    dateKey,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    matchCount: matches.length,
    matches
  });

  console.log(`Firestore'a yazıldı: ${matches.length} maç, ${Object.keys(oddsByFixture).length} maçta oran var.`);
}

main().catch(err => {
  console.error("Script hata verdi:", err);
  process.exit(1);
});
