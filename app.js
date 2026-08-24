import { db, authReady, USERS } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, increment,
  collection, query, where, orderBy, onSnapshot, getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================================================
   STATE
   ============================================================ */
const ADMIN_USER = "Nihat";
function isAdmin() { return currentUser === ADMIN_USER; }

let currentUser = localStorage.getItem("kupon_user") || null;
let activeCouponId = null;
let couponsCache = [];
let unsubCouponList = null;
let unsubCouponDetail = null;
let unsubPool = null;
let modalTargetUser = null;
let poolBalance = 0;
const poolRef = doc(db, "meta", "pool");

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
  if (unsubPool) unsubPool();
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
  subscribePool();
}

/* ============================================================
   ORTAK KASA (HAVUZ)
   ============================================================ */
function subscribePool() {
  if (unsubPool) unsubPool();
  unsubPool = onSnapshot(poolRef, async (snap) => {
    if (!snap.exists()) {
      try { await setDoc(poolRef, { balance: 0 }); } catch (e) { console.error(e); }
      return;
    }
    poolBalance = Number(snap.data().balance || 0);
    renderPoolCard();
    // Kupon detayındaysak, havuz bakiyesine bağlı butonları (etiketler vb.) tazele
    const cc = couponsCache.find(x => x.id === activeCouponId);
    if (cc && document.getElementById("view-coupon").classList.contains("active")) {
      renderCouponDetail(cc);
    }
  });
}

function renderPoolCard() {
  const el = document.getElementById("pool-card");
  if (!el) return;
  el.innerHTML = `
    <span class="pool-icon">🏦</span>
    <div>
      <div class="pool-label">Ortak Kasa</div>
      <div class="pool-value">${poolBalance.toFixed(0)}₺</div>
    </div>
    ${isAdmin() ? `<button id="pool-edit-btn" class="pool-edit-btn" title="Manuel düzelt">✎</button>` : ""}
  `;
  const editBtn = document.getElementById("pool-edit-btn");
  if (editBtn) editBtn.addEventListener("click", adjustPoolManually);
}

async function adjustPoolManually() {
  const input = window.prompt("Havuza eklenecek/çıkarılacak tutarı gir (çıkarmak için başına - koy). Örn: 200 veya -50");
  if (input === null) return;
  const value = parseFloat(input.replace(",", "."));
  if (isNaN(value) || value === 0) return;
  try {
    await updateDoc(poolRef, { balance: increment(value) });
    showToast(`Havuz güncellendi (${value > 0 ? "+" : ""}${value}₺)`);
  } catch (err) {
    console.error(err);
    showToast("Havuz güncellenemedi: " + (err.code || err.message));
  }
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

function couponTotals(c) {
  let totalStake = 0, totalOdds = 1, filled = 0;
  USERS.forEach(u => {
    const m = c.matches ? c.matches[u] : null;
    if (m) {
      totalStake += Number(m.amount || 0);
      totalOdds *= Number(m.odds || 1);
      filled++;
    }
  });
  const payout = filled > 0 ? totalStake * totalOdds : 0;
  return { totalStake, totalOdds, payout, filled };
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

  const adminBar = document.getElementById("admin-bar");
  if (isAdmin()) {
    adminBar.classList.remove("hidden");
    adminBar.innerHTML = `
      <span class="admin-tag">★ Admin</span>
      <button id="delete-coupon-btn" class="btn-danger">🗑 Kuponu Sil</button>
    `;
    document.getElementById("delete-coupon-btn").addEventListener("click", () => deleteCoupon(c.id));
  } else {
    adminBar.classList.add("hidden");
    adminBar.innerHTML = "";
  }

  const slotsEl = document.getElementById("match-slots");
  slotsEl.innerHTML = "";
  USERS.forEach((user, i) => {
    const m = c.matches ? c.matches[user] : null;
    const result = c.results ? c.results[user] : null;
    const isSelf = user === currentUser;
    const canEditThis = isAdmin() || (isSelf && !m);
    const slot = document.createElement("div");

    if (!m) {
      slot.className = `match-slot slot-empty ${isSelf ? "slot-self" : ""}`;
      slot.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <div class="slot-body">
          <div class="slot-player">${user}</div>
          <div class="slot-empty-label">${isSelf ? "Maçını girmek için dokun →" : "Maç bekleniyor…"}</div>
        </div>
        ${isAdmin() && !isSelf ? `<button class="slot-fill-btn" data-user="${user}">Doldur</button>` : ""}
      `;
      if (isSelf) slot.addEventListener("click", () => openMatchModal(user, null, c.id));
      const fillBtn = slot.querySelector(".slot-fill-btn");
      if (fillBtn) fillBtn.addEventListener("click", (e) => { e.stopPropagation(); openMatchModal(user, null, c.id); });
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
          <div class="slot-amount">${Number(m.amount || 0)}₺ yatırdı</div>
        </div>
        <span class="slot-odds">${Number(m.odds).toFixed(2)}</span>
        ${resultBadge}
        ${isAdmin() ? `<button class="slot-edit-btn" data-user="${user}" title="Düzenle">✎</button>` : ""}
      `;
      if (isAdmin()) {
        slot.querySelector(".slot-edit-btn").addEventListener("click", () => openMatchModal(user, m, c.id));
      }
    }
    slotsEl.appendChild(slot);
  });

  const summaryEl = document.getElementById("kupon-summary");
  const totals = couponTotals(c);
  if (totals.filled > 0) {
    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = `
      <div class="kupon-summary-item">
        <div class="kupon-summary-value">${totals.totalStake}₺</div>
        <div class="kupon-summary-label">Toplam Yatırım</div>
      </div>
      <div class="kupon-summary-item">
        <div class="kupon-summary-value">${totals.totalOdds.toFixed(2)}</div>
        <div class="kupon-summary-label">Toplam Oran</div>
      </div>
      <div class="kupon-summary-item">
        <div class="kupon-summary-value">${totals.payout.toFixed(0)}₺</div>
        <div class="kupon-summary-label">Olası Kazanç${totals.filled < 4 ? " (şimdilik)" : ""}</div>
      </div>
    `;
  } else {
    summaryEl.classList.add("hidden");
    summaryEl.innerHTML = "";
  }

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
    footer.innerHTML = `<p class="footer-note">4 maç da girildi. Kupon parası nereden karşılanacak?</p>`;
    const totals = couponTotals(c);
    const row = document.createElement("div");
    row.className = "fund-choice-row";
    row.innerHTML = `
      <button id="fund-players-btn" class="btn-primary">👥 Kullanıcılardan</button>
      <button id="fund-pool-btn" class="btn-secondary">🏦 Havuzdan <span class="fund-pool-balance">(${poolBalance.toFixed(0)}₺)</span></button>
    `;
    footer.appendChild(row);
    footer.insertAdjacentHTML("beforeend", `<p class="footer-note fund-note">Gerekli tutar: ${totals.totalStake}₺</p>`);
    document.getElementById("fund-players-btn").addEventListener("click", () => markPlayed(c, "players"));
    document.getElementById("fund-pool-btn").addEventListener("click", () => markPlayed(c, "pool"));
    return;
  }

  // played / won / lost — sonuç bölümü
  const canEditResults = isAdmin() || c.playedBy === currentUser;

  if (info.key === "won" || info.key === "lost") {
    const won = info.key === "won";
    const fundLabel = c.fundingSource === "pool" ? "Havuzdan" : "Kullanıcılardan";
    footer.innerHTML = `
      <div class="final-banner ${won ? "won" : "lost"}">${won ? "🏆 Kupon Tuttu" : "Kupon Tutmadı"}</div>
      <p class="play-summary">Oynatan: <strong>${c.playedBy}</strong> · Kaynak: <strong>${fundLabel}</strong></p>
    `;

    if (won) {
      if (c.payoutAction) {
        const label = c.payoutAction === "pooled" ? "Havuza eklendi" : "Kişilere dağıtıldı";
        footer.insertAdjacentHTML("beforeend", `<p class="footer-note payout-done">Kazanç: <strong>${label}</strong></p>`);
      } else if (canEditResults) {
        const totals = couponTotals(c);
        footer.insertAdjacentHTML("beforeend", `<p class="footer-note">Kazanılan <strong>${totals.payout.toFixed(0)}₺</strong> ne oldu?</p>`);
        const row = document.createElement("div");
        row.className = "fund-choice-row";
        row.innerHTML = `
          <button id="payout-distribute-btn" class="btn-primary">💸 Kişilere Dağıtıldı</button>
          <button id="payout-pool-btn" class="btn-secondary">🏦 Havuza Aktar</button>
        `;
        footer.appendChild(row);
        document.getElementById("payout-distribute-btn").addEventListener("click", () => setPayoutAction(c, "distributed"));
        document.getElementById("payout-pool-btn").addEventListener("click", () => setPayoutAction(c, "pooled"));
      }
    }

    if (isAdmin()) {
      footer.insertAdjacentHTML("beforeend", `<p class="footer-note">Admin olarak sonuçları aşağıdan değiştirebilirsin:</p>`);
      appendResultRows(footer, c);
    }
    return;
  }

  // status: played, sonuçlar tam değil
  const fundLabel = c.fundingSource === "pool" ? "Havuzdan" : "Kullanıcılardan";
  if (!canEditResults) {
    footer.innerHTML = `<p class="footer-note">Kuponu <strong>${c.playedBy}</strong> oynattı (${fundLabel}). Sonuçları o (ya da admin) işaretleyecek.</p>`;
    return;
  }
  footer.insertAdjacentHTML("beforeend", `<p class="footer-note">${c.playedBy === currentUser ? "Kuponu sen oynattın" : "Admin olarak"} (${fundLabel}). Maçlar bitince sonuçları işaretle:</p>`);
  appendResultRows(footer, c);
}

function appendResultRows(footer, c) {
  const wrap = document.createElement("div");
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
}

async function deleteCoupon(couponId) {
  const c = couponsCache.find(x => x.id === couponId);
  const ok = window.confirm(`"${c ? c.displayName : couponId}" kuponunu kalıcı olarak silmek istediğine emin misin? Bu işlem geri alınamaz.`);
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "coupons", couponId));
  } catch (err) {
    console.error("Kupon silinemedi:", err);
    showToast("Silinemedi: " + (err.code || err.message || "bilinmeyen hata"));
    return;
  }
  if (unsubCouponDetail) unsubCouponDetail();
  showToast("Kupon silindi");
  switchView("home");
  document.querySelector('.nav-btn[data-view="home"]').classList.add("active");
}

async function markPlayed(c, source) {
  const totals = couponTotals(c);
  if (source === "pool") {
    if (poolBalance < totals.totalStake) {
      showToast(`Havuzda yeterli bakiye yok (Havuz: ${poolBalance.toFixed(0)}₺, Gerekli: ${totals.totalStake}₺)`);
      return;
    }
    try {
      await updateDoc(poolRef, { balance: increment(-totals.totalStake) });
    } catch (err) {
      console.error(err);
      showToast("Havuz güncellenemedi: " + (err.code || err.message));
      return;
    }
  }
  await updateDoc(doc(db, "coupons", c.id), {
    playedBy: currentUser,
    playedAt: serverTimestamp(),
    fundingSource: source
  });
  showToast(source === "pool" ? `Kupon havuzdan oynatıldı (-${totals.totalStake}₺)` : "Kupon onaylandı, iyi şanslar!");
}

async function setPayoutAction(c, action) {
  const totals = couponTotals(c);
  if (action === "pooled") {
    try {
      await updateDoc(poolRef, { balance: increment(totals.payout) });
    } catch (err) {
      console.error(err);
      showToast("Havuz güncellenemedi: " + (err.code || err.message));
      return;
    }
  }
  await updateDoc(doc(db, "coupons", c.id), { payoutAction: action });
  showToast(action === "pooled" ? `+${totals.payout.toFixed(0)}₺ havuza eklendi` : "Kazanç dağıtıldı olarak işaretlendi");
}

async function setResult(couponId, user, val) {
  await updateDoc(doc(db, "coupons", couponId), {
    [`results.${user}`]: val
  });
}

/* ============================================================
   MATCH MODAL
   ============================================================ */
function openMatchModal(targetUser, existingMatch, couponId) {
  activeCouponId = couponId || activeCouponId;
  modalTargetUser = targetUser;
  document.getElementById("input-teams").value = existingMatch ? existingMatch.teams : "";
  document.getElementById("input-prediction").value = existingMatch ? existingMatch.prediction : "";
  document.getElementById("input-odds").value = existingMatch ? existingMatch.odds : "";
  document.getElementById("input-amount").value = existingMatch ? existingMatch.amount : "";
  document.getElementById("modal-error").classList.add("hidden");
  const heading = document.querySelector("#match-modal .ticket-eyebrow");
  heading.textContent = targetUser === currentUser
    ? "Maçını gir"
    : `${targetUser} adına düzenle (Admin)`;
  document.getElementById("match-modal").classList.remove("hidden");
}
function closeMatchModal() {
  document.getElementById("match-modal").classList.add("hidden");
}

async function submitMatch() {
  const teams = document.getElementById("input-teams").value.trim();
  const prediction = document.getElementById("input-prediction").value.trim();
  const odds = parseFloat(document.getElementById("input-odds").value);
  const amount = parseFloat(document.getElementById("input-amount").value);
  const errEl = document.getElementById("modal-error");

  if (!teams || !prediction || !odds || !amount || amount <= 0) {
    errEl.textContent = "Tüm alanları doğru şekilde doldur.";
    errEl.classList.remove("hidden");
    return;
  }

  await updateDoc(doc(db, "coupons", activeCouponId), {
    [`matches.${modalTargetUser}`]: {
      teams, prediction, odds, amount,
      enteredAt: serverTimestamp()
    }
  });
  closeMatchModal();
  showToast("Maç kaydedildi ✔");
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
    let matchCount = 0, oddsSum = 0, oddsCount = 0, resultCount = 0, hitCount = 0, amountSum = 0;
    couponsCache.forEach(c => {
      const m = c.matches ? c.matches[user] : null;
      if (m) { matchCount++; oddsSum += Number(m.odds); oddsCount++; amountSum += Number(m.amount || 0); }
      const r = c.results ? c.results[user] : null;
      if (r) { resultCount++; if (r === "tuttu") hitCount++; }
    });
    const avgOdds = oddsCount ? (oddsSum / oddsCount).toFixed(2) : "—";
    const hitRate = resultCount ? Math.round((hitCount / resultCount) * 100) : null;
    const card = document.createElement("div");
    card.className = "player-card";
    card.innerHTML = `
      <div class="player-card-name">${user}${user === ADMIN_USER ? " ★" : ""}</div>
      <div class="player-stat-line"><span>Girdiği maç</span><span>${matchCount}</span></div>
      <div class="player-stat-line"><span>Toplam yatırım</span><span>${amountSum}₺</span></div>
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
   RULES
   ============================================================ */
const RULES = [
  "Her kuponda her kişi sadece 1 maç verebilir.",
  "Verilen maçın oranı 2.00 ve üzeri olmalıdır.",
  "Kuponu oynayan son kişi, kuponu kaydeder ve toplam kupon tutarını gruba yazar.",
  "Kuponda maçı kaybeden kişi veya kişiler, kazanan kişilerin kupon ücretini öder.",
  "Kimse, kendi tuttuğu takıma, garanti gördüğü maçlarda dahi oynayamaz.",
  "Her ay en çok maç kaybeden kişi, bir kuponu tek başına ödeyerek oynar."
];
const RULE_EMOJIS = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣"];

function renderRules() {
  const list = document.getElementById("rules-list");
  if (!list) return;
  list.innerHTML = "";
  RULES.forEach((text, i) => {
    const card = document.createElement("div");
    card.className = "rule-card";
    card.innerHTML = `
      <span class="rule-num">${RULE_EMOJIS[i] || (i + 1) + "."}</span>
      <span class="rule-text">${escapeHtml(text)}</span>
    `;
    list.appendChild(card);
  });
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
  renderRules();
  if (currentUser) {
    enterApp();
  }
}
boot();
