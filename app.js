import { db, authReady, USERS } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, updateDoc,
  collection, query, where, orderBy, onSnapshot, getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================================================
   STATE
   ============================================================ */
let currentUser = localStorage.getItem("kupon_user") || null;
let activeCouponId = null;
let couponsCache = [];
let unsubCouponList = null;
let unsubCouponDetail = null;

const pinState = { mode: "login", stage: "first", first: "", current: "", targetName: null };

/* ============================================================
   HELPERS
   ============================================================ */
function pad(n) { return String(n).padStart(2, "0"); }
function dateKeyFor(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function displayDateFor(d) { return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}
function switchView(name) {
  document.querySelectorAll(".app-shell .view").forEach(v => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
}

/* ============================================================
   LOGIN FLOW
   ============================================================ */
function renderNameGrid() {
  const grid = document.getElementById("name-select");
  grid.innerHTML = "";
  USERS.forEach((name, i) => {
    const btn = document.createElement("button");
    btn.className = "name-card";
    btn.innerHTML = `<span class="jersey-num">#${i + 1}</span>${name}`;
    btn.addEventListener("click", () => startPinFlow(name));
    grid.appendChild(btn);
  });
}

async function startPinFlow(name) {
  pinState.targetName = name;
  pinState.first = "";
  pinState.current = "";
  pinState.stage = "first";

  document.getElementById("name-select").classList.add("hidden");
  document.getElementById("pin-pad").classList.remove("hidden");
  document.getElementById("pin-name").textContent = name;
  document.getElementById("pin-error").classList.add("hidden");

  const userRef = doc(db, "users", name);
  const snap = await getDoc(userRef);
  if (snap.exists() && snap.data().pinSet) {
    pinState.mode = "login";
    document.getElementById("pin-sub").textContent = "4 haneli şifreni gir";
  } else {
    pinState.mode = "create";
    document.getElementById("pin-sub").textContent = "İlk giriş: 4 haneli bir şifre oluştur";
  }
  renderPinDots();
}

function renderPinDots() {
  const dots = document.querySelectorAll(".pin-dot");
  dots.forEach((d, i) => d.classList.toggle("filled", i < pinState.current.length));
}

async function handlePinDigit(digit) {
  if (pinState.current.length >= 4) return;
  pinState.current += digit;
  renderPinDots();
  if (pinState.current.length === 4) {
    setTimeout(processPinComplete, 180);
  }
}

function handlePinDelete() {
  pinState.current = pinState.current.slice(0, -1);
  renderPinDots();
}

async function processPinComplete() {
  const errEl = document.getElementById("pin-error");
  errEl.classList.add("hidden");

  if (pinState.mode === "login") {
    const snap = await getDoc(doc(db, "users", pinState.targetName));
    const realPin = snap.exists() ? snap.data().pin : null;
    if (pinState.current === realPin) {
      loginAs(pinState.targetName);
    } else {
      errEl.textContent = "Şifre yanlış, tekrar dene.";
      errEl.classList.remove("hidden");
      pinState.current = "";
      renderPinDots();
    }
    return;
  }

  // mode === create
  if (pinState.stage === "first") {
    pinState.first = pinState.current;
    pinState.current = "";
    pinState.stage = "confirm";
    document.getElementById("pin-sub").textContent = "Şifreni onayla";
    renderPinDots();
    return;
  }

  // stage === confirm
  if (pinState.current === pinState.first) {
    await setDoc(doc(db, "users", pinState.targetName), { pin: pinState.first, pinSet: true });
    loginAs(pinState.targetName);
  } else {
    errEl.textContent = "Şifreler eşleşmedi, baştan dene.";
    errEl.classList.remove("hidden");
    pinState.stage = "first";
    pinState.first = "";
    pinState.current = "";
    document.getElementById("pin-sub").textContent = "4 haneli bir şifre oluştur";
    renderPinDots();
  }
}

function loginAs(name) {
  currentUser = name;
  localStorage.setItem("kupon_user", name);
  enterApp();
}

function logout() {
  currentUser = null;
  localStorage.removeItem("kupon_user");
  if (unsubCouponList) unsubCouponList();
  if (unsubCouponDetail) unsubCouponDetail();
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("view-login").classList.add("active");
  document.getElementById("pin-pad").classList.add("hidden");
  document.getElementById("name-select").classList.remove("hidden");
  pinState.current = ""; pinState.first = "";
  renderNameGrid();
}

/* ============================================================
   APP ENTRY
   ============================================================ */
function enterApp() {
  document.getElementById("view-login").classList.remove("active");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("current-user-tag").textContent = currentUser;
  switchView("home");
  subscribeCouponList();
}

/* ============================================================
   COUPON LIST
   ============================================================ */
function subscribeCouponList() {
  if (unsubCouponList) unsubCouponList();
  const q = query(collection(db, "coupons"), orderBy("createdAt", "desc"));
  unsubCouponList = onSnapshot(q, (snap) => {
    couponsCache = [];
    snap.forEach(d => couponsCache.push({ id: d.id, ...d.data() }));
    renderCouponList();
    renderStats();
  });
}

function couponProgress(c) {
  return USERS.filter(u => c.matches && c.matches[u]).length;
}
function couponStatusInfo(c) {
  const filled = couponProgress(c);
  if (filled < 4) return { key: "open", label: "Açık" };
  if (!c.playedBy) return { key: "ready", label: "Hazır" };
  const resultsFilled = USERS.filter(u => c.results && c.results[u]).length;
  if (resultsFilled < 4) return { key: "played", label: "Oynandı" };
  const won = USERS.every(u => c.results[u] === "tuttu");
  return won ? { key: "won", label: "Tuttu" } : { key: "lost", label: "Tutmadı" };
}

function renderCouponList() {
  const list = document.getElementById("coupon-list");
  list.innerHTML = "";
  if (couponsCache.length === 0) {
    list.innerHTML = `<div class="empty-note">Henüz kupon yok. "+ Yeni Kupon" ile ilkini aç.</div>`;
    return;
  }
  couponsCache.forEach(c => {
    const info = couponStatusInfo(c);
    const filled = couponProgress(c);
    const row = document.createElement("div");
    row.className = "coupon-row";
    row.innerHTML = `
      <div class="coupon-row-left">
        <div>
          <div class="coupon-date">${c.displayName}</div>
          <div class="coupon-progress">${filled}/4 maç girildi${c.playedBy ? " · Oynatan: " + c.playedBy : ""}</div>
        </div>
      </div>
      <span class="status-pill status-${info.key}">${info.label}</span>
    `;
    row.addEventListener("click", () => openCoupon(c.id));
    list.appendChild(row);
  });
}

async function createNewCoupon() {
  const now = new Date();
  const dateKey = dateKeyFor(now);
  const displayDate = displayDateFor(now);
  const q = query(collection(db, "coupons"), where("dateKey", "==", dateKey));
  const snap = await getDocs(q);
  const seq = snap.size + 1;
  const docId = seq === 1 ? dateKey : `${dateKey}-${seq}`;
  const displayName = seq === 1 ? displayDate : `${displayDate} (${seq})`;

  const matches = {}, results = {};
  USERS.forEach(u => { matches[u] = null; results[u] = null; });

  await setDoc(doc(db, "coupons", docId), {
    dateKey, seq, displayName,
    createdAt: serverTimestamp(),
    createdBy: currentUser,
    matches, results,
    playedBy: null, playedAt: null
  });
  showToast(`${displayName} kuponu açıldı`);
  openCoupon(docId);
}

/* ============================================================
   COUPON DETAIL
   ============================================================ */
function openCoupon(id) {
  activeCouponId = id;
  switchView("coupon");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));

  if (unsubCouponDetail) unsubCouponDetail();
  unsubCouponDetail = onSnapshot(doc(db, "coupons", id), (snap) => {
    if (!snap.exists()) return;
    renderCouponDetail({ id: snap.id, ...snap.data() });
  });
}

function renderCouponDetail(c) {
  document.getElementById("coupon-title").textContent = c.displayName;
  const info = couponStatusInfo(c);
  const statusEl = document.getElementById("coupon-status");
  statusEl.textContent = info.label;
  statusEl.className = `status-pill status-${info.key}`;

  const slotsEl = document.getElementById("match-slots");
  slotsEl.innerHTML = "";
  USERS.forEach((user, i) => {
    const m = c.matches ? c.matches[user] : null;
    const result = c.results ? c.results[user] : null;
    const isSelf = user === currentUser;
    const slot = document.createElement("div");

    if (!m) {
      slot.className = `match-slot slot-empty ${isSelf ? "slot-self" : ""}`;
      slot.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <div class="slot-body">
          <div class="slot-player">${user}</div>
          <div class="slot-empty-label">${isSelf ? "Maçını girmek için dokun →" : "Maç bekleniyor…"}</div>
        </div>
      `;
      if (isSelf) slot.addEventListener("click", () => openMatchModal(c.id));
    } else {
      slot.className = "match-slot";
      let resultBadge = "";
      if (result === "tuttu") resultBadge = `<span class="slot-result status-won">Tuttu</span>`;
      else if (result === "tutmadi") resultBadge = `<span class="slot-result status-lost">Tutmadı</span>`;
      slot.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <div class="slot-body">
          <div class="slot-player">${user}</div>
          <div class="slot-teams">${escapeHtml(m.teams)}</div>
          <div class="slot-prediction">${escapeHtml(m.prediction)}</div>
        </div>
        <span class="slot-odds">${Number(m.odds).toFixed(2)}</span>
        ${resultBadge}
      `;
    }
    slotsEl.appendChild(slot);
  });

  renderTicketFooter(c, info);
}

function renderTicketFooter(c, info) {
  const footer = document.getElementById("ticket-footer");
  footer.innerHTML = "";

  if (info.key === "open") {
    footer.innerHTML = `<p class="footer-note">Herkes kendi maçını girdiğinde kupon hazır olacak.</p>`;
    return;
  }

  if (info.key === "ready") {
    const btn = document.createElement("button");
    btn.className = "btn-primary full";
    btn.textContent = "Bu Kuponu Onadım";
    btn.addEventListener("click", () => markPlayed(c.id));
    footer.appendChild(btn);
    footer.insertAdjacentHTML("beforeend", `<p class="footer-note">4 maç da girildi. Kuponu oynayan kişi burada onaylasın.</p>`);
    return;
  }

  if (info.key === "played") {
    if (c.playedBy !== currentUser) {
      footer.innerHTML = `<p class="footer-note">Kuponu <strong>${c.playedBy}</strong> oynattı. Sonuçları o işaretleyecek.</p>`;
      return;
    }
    const wrap = document.createElement("div");
    wrap.innerHTML = `<p class="footer-note">Kuponu sen oynattın. Maçlar bitince sonuçları işaretle:</p>`;
    USERS.forEach(user => {
      const m = c.matches[user];
      const result = c.results ? c.results[user] : null;
      const row = document.createElement("div");
      row.className = "result-row";
      row.innerHTML = `
        <span class="result-teams">${user}: ${escapeHtml(m.teams)}</span>
        <span class="result-btns">
          <button class="result-btn win-btn ${result === "tuttu" ? "active" : ""}" data-user="${user}" data-val="tuttu">Tuttu</button>
          <button class="result-btn lose-btn ${result === "tutmadi" ? "active" : ""}" data-user="${user}" data-val="tutmadi">Tutmadı</button>
        </span>
      `;
      wrap.appendChild(row);
    });
    footer.appendChild(wrap);
    footer.querySelectorAll(".result-btn").forEach(btn => {
      btn.addEventListener("click", () => setResult(c.id, btn.dataset.user, btn.dataset.val));
    });
    return;
  }

  // won / lost -> finished
  const won = info.key === "won";
  footer.innerHTML = `
    <div class="final-banner ${won ? "won" : "lost"}">${won ? "🏆 Kupon Tuttu" : "Kupon Tutmadı"}</div>
    <p class="play-summary">Oynatan: <strong>${c.playedBy}</strong></p>
  `;
}

async function markPlayed(couponId) {
  await updateDoc(doc(db, "coupons", couponId), {
    playedBy: currentUser,
    playedAt: serverTimestamp()
  });
  showToast("Kupon onaylandı, iyi şanslar!");
}

async function setResult(couponId, user, val) {
  await updateDoc(doc(db, "coupons", couponId), {
    [`results.${user}`]: val
  });
}

/* ============================================================
   MATCH MODAL
   ============================================================ */
function openMatchModal() {
  document.getElementById("input-teams").value = "";
  document.getElementById("input-prediction").value = "";
  document.getElementById("input-odds").value = "";
  document.getElementById("modal-error").classList.add("hidden");
  document.getElementById("match-modal").classList.remove("hidden");
}
function closeMatchModal() {
  document.getElementById("match-modal").classList.add("hidden");
}

async function submitMatch() {
  const teams = document.getElementById("input-teams").value.trim();
  const prediction = document.getElementById("input-prediction").value.trim();
  const odds = parseFloat(document.getElementById("input-odds").value);
  const errEl = document.getElementById("modal-error");

  if (!teams || !prediction || !odds || odds <= 1) {
    errEl.textContent = "Tüm alanları doğru şekilde doldur.";
    errEl.classList.remove("hidden");
    return;
  }

  await updateDoc(doc(db, "coupons", activeCouponId), {
    [`matches.${currentUser}`]: {
      teams, prediction, odds,
      enteredAt: serverTimestamp()
    }
  });
  closeMatchModal();
  showToast("Maçın kaydedildi ✔");
}

/* ============================================================
   STATS
   ============================================================ */
function renderStats() {
  const finished = couponsCache.filter(c => couponStatusInfo(c).key === "won" || couponStatusInfo(c).key === "lost");
  const wonCount = finished.filter(c => couponStatusInfo(c).key === "won").length;
  const winRate = finished.length ? Math.round((wonCount / finished.length) * 100) : 0;

  document.getElementById("overall-stats").innerHTML = `
    <div class="stat-box"><div class="stat-value">${couponsCache.length}</div><div class="stat-label">Toplam Kupon</div></div>
    <div class="stat-box"><div class="stat-value">${finished.length}</div><div class="stat-label">Sonuçlanan</div></div>
    <div class="stat-box"><div class="stat-value">${wonCount}</div><div class="stat-label">Tutan</div></div>
    <div class="stat-box"><div class="stat-value">%${winRate}</div><div class="stat-label">Genel İsabet</div></div>
  `;

  const playerGrid = document.getElementById("player-stats");
  playerGrid.innerHTML = "";
  USERS.forEach(user => {
    let matchCount = 0, oddsSum = 0, oddsCount = 0, resultCount = 0, hitCount = 0;
    couponsCache.forEach(c => {
      const m = c.matches ? c.matches[user] : null;
      if (m) { matchCount++; oddsSum += Number(m.odds); oddsCount++; }
      const r = c.results ? c.results[user] : null;
      if (r) { resultCount++; if (r === "tuttu") hitCount++; }
    });
    const avgOdds = oddsCount ? (oddsSum / oddsCount).toFixed(2) : "—";
    const hitRate = resultCount ? Math.round((hitCount / resultCount) * 100) : null;
    const card = document.createElement("div");
    card.className = "player-card";
    card.innerHTML = `
      <div class="player-card-name">${user}</div>
      <div class="player-stat-line"><span>Girdiği maç</span><span>${matchCount}</span></div>
      <div class="player-stat-line"><span>Ortalama oran</span><span>${avgOdds}</span></div>
      <div class="player-stat-line"><span>Kendi isabet oranı</span><span>${hitRate === null ? "—" : "%" + hitRate}</span></div>
    `;
    playerGrid.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
document.getElementById("back-to-names").addEventListener("click", () => {
  document.getElementById("pin-pad").classList.add("hidden");
  document.getElementById("name-select").classList.remove("hidden");
  pinState.current = ""; pinState.first = "";
});

document.querySelectorAll(".key[data-k]").forEach(k => {
  k.addEventListener("click", () => handlePinDigit(k.dataset.k));
});
document.getElementById("pin-del").addEventListener("click", handlePinDelete);

document.getElementById("logout-btn").addEventListener("click", logout);

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

document.getElementById("new-coupon-btn").addEventListener("click", createNewCoupon);
document.getElementById("back-to-home").addEventListener("click", () => {
  if (unsubCouponDetail) unsubCouponDetail();
  switchView("home");
  document.querySelector('.nav-btn[data-view="home"]').classList.add("active");
});

document.getElementById("close-modal").addEventListener("click", closeMatchModal);
document.getElementById("submit-match").addEventListener("click", submitMatch);

/* ============================================================
   BOOT
   ============================================================ */
async function boot() {
  await authReady;
  renderNameGrid();
  if (currentUser) {
    enterApp();
  }
}
boot();
