# Kupon — Nihat, Mahir, Cenk, Ebuzer

4 kişilik ortak iddaa kupon takip sitesi. Her gün (istenirse günde birden fazla)
yeni bir kupon açılır, 4 kişi kendi maçını girer (takım, tahmin, oran), biri
kuponu oynadığını onaylar, sonra sonuçlar elle işaretlenir. Herkesin kaç maç
girdiği, ortalama oranı ve isabet oranı otomatik hesaplanır.

## Nasıl çalışıyor

- **Giriş:** İsmini seç (Nihat / Mahir / Cenk / Ebuzer), ilk girişte 4 haneli
  bir şifre oluşturursun, sonraki girişlerde aynı şifreyi girersin.
- **Kupon adı:** Otomatik olarak o günün tarihi (örn. `23.08.2026`). Aynı gün
  ikinci kez kupon açılırsa `23.08.2026 (2)` şeklinde numaralanır.
- **Maç girme:** Kupon açıkken herkes sadece **kendi** satırına maç girer:
  Takımlar → Tahmin → Oran. Girildikten sonra **değiştirilemez**.
- **Onaylama:** 4 maç da girilince, kuponu kim fiilen oynadıysa "Bu Kuponu
  Onadım" butonuna basar. İlk basan kişi kaydedilir.
- **Sonuç:** Maçlar oynandıktan sonra, kuponu onaylayan kişi her maçı tek tek
  "Tuttu / Tutmadı" olarak işaretler. 4'ü de "Tuttu" ise kupon "Tuttu" sayılır.
- **İstatistikler:** Üst menüden "İstatistik" — kişi başına girilen maç sayısı,
  ortalama oran, kişisel isabet oranı; genel kupon sayısı ve genel isabet oranı.

## Kurulum

### 1) Firebase projesi oluştur (ücretsiz)

1. https://console.firebase.google.com → **Proje ekle**
2. Sol menüden **Build → Firestore Database → Veritabanı oluştur** (production
   mode seçebilirsin, kuralları zaten aşağıda ayarlayacağız)
3. Sol menüden **Build → Authentication → Sign-in method** → **Anonymous**'u
   etkinleştir (uygulama arka planda sessizce anonim giriş yapıyor, bu sadece
   Firestore kurallarının çalışması için — kullanıcıya hiçbir şey görünmez)
4. **Proje ayarları (dişli ikonu) → Genel → Uygulamalarınız → Web (`</>`)**
   ile bir web app ekle, sana verilen `firebaseConfig` nesnesini kopyala

### 2) Kendi bilgilerini gir

`firebase-config.js` dosyasını aç, en üstteki `firebaseConfig` nesnesindeki
`BURAYA_...` yazan yerleri Firebase'den kopyaladığın değerlerle değiştir.

### 3) Güvenlik kurallarını yükle

Firebase Console → Firestore Database → **Rules** sekmesine git,
`firestore.rules` dosyasının içeriğini yapıştır ve **Publish**'e bas.

### 4) GitHub Pages'e yükle

1. Bu klasördeki tüm dosyaları bir GitHub reposuna yükle
   (`index.html`, `style.css`, `app.js`, `firebase-config.js`)
2. Repo → **Settings → Pages → Source: Deploy from a branch**, branch olarak
   `main` / `root` seç, **Save**
3. Birkaç dakika içinde `https://kullanici-adin.github.io/repo-adi/` adresinden
   erişilebilir olur

## Önemli notlar

- **Güvenlik seviyesi:** Bu, 4 arkadaş arasında kullanılmak üzere tasarlandı.
  PIN kontrolü tarayıcı tarafında yapılıyor, banka seviyesinde bir güvenlik
  değil. Repo'yu / site linkini herkese açık paylaşmayın, yeterli olur.
- **Kupon mantığı:** Kombine kupon mantığıyla çalışır — 4 maçtan biri bile
  "Tutmadı" olarak işaretlenirse kupon genel olarak "Tutmadı" sayılır.
- Firebase ücretsiz (Spark) plan bu kullanım için (birkaç kullanıcı, günde
  birkaç kupon) fazlasıyla yeterli, herhangi bir ücret ödemeniz gerekmez.

## Dosya yapısı

```
index.html          → sayfa iskeleti (giriş, ana ekran, kupon, istatistik)
style.css            → tüm tasarım (stadyum yeşili + kağıt bilet teması)
app.js                → uygulama mantığı (Firestore okuma/yazma, ekran geçişleri)
firebase-config.js   → kendi Firebase bilgilerinizi girdiğiniz dosya
firestore.rules      → Firebase Console'a yapıştıracağınız güvenlik kuralları
```
