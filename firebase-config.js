// ============================================================
// FIREBASE YAPILANDIRMASI
// ============================================================
// 1) https://console.firebase.google.com adresinde ücretsiz bir proje aç
// 2) Proje ayarları > Genel > "Web uygulaması ekle" ile bir web app oluştur
// 3) Sana verilen firebaseConfig nesnesini aşağıya yapıştır
// 4) Firestore Database'i "Native mode" ile oluştur (Test mode ile başlayabilirsin,
//    sonra firestore.rules dosyasındaki kuralları Firebase Console > Firestore > Rules
//    kısmına yapıştır)
// 5) Authentication > Sign-in method > Anonymous'u AÇIK yap (uygulama arka planda
//    anonim giriş yapıyor, bu Firestore kurallarının çalışması için gerekli)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyClENcWk3y4xYWHKc6KFKBES5cXF9BLPhc",
  authDomain: "maclar-e8b25.firebaseapp.com",
  projectId: "maclar-e8b25",
  storageBucket: "maclar-e8b25.firebasestorage.app",
  messagingSenderId: "889862054206",
  appId: "1:889862054206:web:7847721c38b08ef8780c6f"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Firestore güvenlik kurallarının çalışabilmesi için sessizce anonim giriş yapılır.
// Kullanıcıya gösterilen isim+PIN girişiyle hiçbir ilgisi yok, sadece "bu istek
// bizim sitemizden geliyor" diye Firebase'e kanıt sunuyor.
export const authReady = signInAnonymously(auth).catch((err) => {
  console.error("Anonim giriş başarısız:", err);
});

// Sabit 4 oyuncu
export const USERS = ["Nihat", "Mahir", "Cenk", "Ebuzer"];
