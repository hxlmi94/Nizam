# Nizam — Kurulum Kılavuzu

Bu belge, uygulamayı sıfırdan internete koyup telefonunuzdan kullanmaya başlamanız için gereken **her adımı** anlatıyor. Sırayla ilerleyin, hiçbir adımı atlamayın. Toplam süre yaklaşık 30-40 dakika.

Uygulamanın adı **Nizam** — sadece Zeytinkule için değil, **birden fazla işletmeniz** (Zeytinkule sitesi, ofisleriniz, inşaat projeleriniz) için tek bir uygulama. Uygulamanın üstünde bir **İşletme Seç** düğmesi olacak; oradan işletmeler arasında geçiş yapabilir, "+ Yeni İşletme Ekle" ile doğrudan uygulama içinden yeni bir ofis veya inşaat projesi ekleyebilirsiniz. Her işletmenin verileri (gelir, gider, personel) birbirinden tamamen ayrı tutulur. Kurulumu (bu belgedeki tüm adımları) **bir kere** yapıyorsunuz — yeni bir işletme eklemek için Neon/GitHub/Render'a tekrar dokunmanız gerekmiyor, sadece uygulama içinden ekliyorsunuz (bkz. Adım 10).

Kuracağınız sistem üç parçadan oluşuyor:
- **Neon** — tüm işletmelerinizin verilerinin (daireler, gelirler, giderler, personel) saklandığı veritabanı. Kredi kartı veya telefon numarası istemez, ücretsiz.
- **GitHub** — kodun saklandığı yer.
- **Render** — uygulamayı internette çalışır hale getiren yer (linkiniz buradan çıkacak).

İsteğe bağlı olarak **Anthropic (Claude)** hesabı da alacaksınız — bu, uygulama içindeki sohbet asistanı içindir. İstemezseniz bu adımı atlayabilirsiniz, uygulamanın geri kalanı yine çalışır.

---

## 1. Neon projesi oluşturma

1. [neon.tech](https://neon.tech) adresine gidin, **Sign up** deyip hesap açın (GitHub veya Google hesabınızla da girebilirsiniz). Kredi kartı veya telefon numarası istemez.
2. İlk girişte sizden bir proje oluşturmanız istenecek: bir isim verin (örn. `nizam`), Postgres sürümü ve bölge için varsayılan seçenekleri değiştirmenize gerek yok (bölgeyi değiştirmek isterseniz Avrupa'ya yakın bir seçenek seçebilirsiniz, örn. Frankfurt).
3. **Create Project** (veya **Create**) deyin, birkaç saniye içinde proje hazır olur ve doğrudan proje panosuna (Dashboard) düşersiniz.

## 2. Veritabanı tablolarını oluşturma

1. Soldaki menüden **SQL Editor**'a tıklayın.
2. Açılan pencerede **New Query** deyin (zaten boş bir editörle karşılaşabilirsiniz).
3. Bu paketteki `schema.sql` dosyasını açın, içindeki **her şeyi** kopyalayın, SQL Editor'a yapıştırın.
4. Sağ üstteki **Run** butonuna basın.
5. Sonuç panelinde hata olmadığını görmelisiniz. Bu işlem Zeytinkule'yi ilk işletmeniz olarak oluşturur ve 71 dairenizi ve mevcut tüm ödeme/gider/personel kayıtlarınızı veritabanına yükler. Ofisleriniz ve inşaat projeleriniz için ayrı bir kurulum yapmanıza gerek yok — onları uygulama açıldıktan sonra doğrudan uygulama içinden ekleyeceksiniz (Adım 10).

> Hata alırsanız: sorgunun tamamını kopyaladığınızdan emin olun (dosya uzun, en baştan en sona kadar).

## 3. Neon bağlantı bilgisini bulma

1. Proje panosunda (Dashboard) üstte veya sağda **Connect** butonuna tıklayın.
2. Açılan **"Connect to your database"** penceresinde hazır bir bağlantı adresi (connection string) göreceksiniz — `postgresql://` ile başlayan uzun bir metin. Bunun tamamını kopyalayın — bu `DATABASE_URL` olacak.

Bu değeri bir kenara not edin, birazdan kullanacağız.

> Bu bağlantı adresi veritabanı şifrenizi de içerir, kimseyle paylaşmayın — sadece Render'daki ayarlara gireceğiz (koda hiçbir zaman yazılmayacak).

## 4. Giriş kodunuzu belirleme

Uygulamaya girerken kullanacağınız tek bir giriş kodu/şifre düşünün (`ADMIN_PASSWORD`) — e-posta gerekmiyor, sadece bu kodu bilen (siz ve paylaştığınız kişiler) giriş yapabilir. Kolay tahmin edilmeyecek ama sizin de rahat hatırlayacağınız bir şey seçin.

## 5. Gizli anahtar (JWT_SECRET) oluşturma

Bu, girişlerinizi güvenli tutan rastgele bir metin. Aşağıdaki adreslerden biriyle rastgele bir metin üretebilirsiniz:
- [1password.com/password-generator](https://1password.com/password-generator) — uzunluğu 40+ karaktere ayarlayıp üretin.

Üretilen metni kopyalayıp not edin — bu `JWT_SECRET` olacak. Kimseyle paylaşmayın.

## 6. Claude sohbet asistanı için API anahtarı (isteğe bağlı)

Uygulamadaki "Asistan" sekmesi bina hakkında soru sormanızı sağlıyor (örn. "Bu ay kimler ödemedi?"). Bu özellik için ayrı bir anahtar gerekiyor ve **ayrı ücretlendirilir** (Neon/Render'dan bağımsız, kullandıkça küçük tutarlar).

1. [console.anthropic.com](https://console.anthropic.com) adresinde hesap açın.
2. **API Keys** bölümünden yeni bir anahtar oluşturun.
3. Ödeme yöntemi ekleyip küçük bir kredi yükleyin (aylık birkaç dolar bu kullanım için yeterli olur).
4. Oluşan anahtarı kopyalayıp not edin — bu `ANTHROPIC_API_KEY` olacak.

Bu adımı atlarsanız uygulamanın geri kalanı (daireler, ödemeler, giderler, personel) tamamen çalışır; sadece "Asistan" sekmesi hata verir.

## 7. Kodu GitHub'a yükleme

1. [github.com](https://github.com) hesabınıza girin.
2. Sağ üstten **+** → **New repository** deyin.
3. İsim verin (örn. `zeytinkule-app`), **Private** seçin (herkese açık olmasın), **Create repository** deyin.
4. Açılan sayfada **uploading an existing file** linkine tıklayın.
5. Bu paketteki tüm dosya ve klasörleri (`server/`, `public/`, `schema.sql`, `.gitignore` — `KURULUM.md` de kalabilir) oraya sürükleyip bırakın.
   - ⚠️ `server/.env` diye bir dosya **YOKTUR** bu pakette ve GitHub'a hiçbir zaman `.env` dosyası yüklemeyin — şifreleriniz açığa çıkar. Sadece `.env.example` yükleyin, o zararsızdır (içi boş).
6. Alt kısımda **Commit changes** deyin.

## 8. Render'da uygulamayı yayınlama

1. [render.com](https://render.com) adresine gidin, hesap açın (GitHub hesabınızla girmeniz en kolayı).
2. Panelde **New +** → **Web Service** seçin (**Static Site** DEĞİL — bu uygulamanın gerçek bir sunucusu var).
3. GitHub reponuzu (`zeytinkule-app`) seçip bağlayın.
4. Ayarları şöyle doldurun:
   - **Name**: istediğiniz bir isim (örn. `zeytinkule`)
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free (ücretsiz) ile başlayabilirsiniz
5. Aşağıda **Environment Variables** bölümüne gelin ve şu değerleri tek tek ekleyin (yukarıdaki adımlarda not ettiğiniz değerler):

   | Anahtar | Değer |
   |---|---|
   | `DATABASE_URL` | (Adım 3'te aldığınız Neon bağlantı adresi) |
   | `JWT_SECRET` | (Adım 5'te ürettiğiniz rastgele metin) |
   | `ADMIN_PASSWORD` | (Adım 4'te belirlediğiniz giriş kodu) |
   | `ANTHROPIC_API_KEY` | (Adım 6'da aldığınız anahtar — atladıysanız boş bırakın) |
   | `ANTHROPIC_MODEL` | `claude-sonnet-5` |

6. **Create Web Service** deyin. Render otomatik olarak kodu indirip kuracak (2-4 dakika sürer).
7. İşlem bitince sayfanın üstünde bir link göreceksiniz, örn. `https://zeytinkule.onrender.com` — işte uygulamanızın linki bu!

> Not: Ücretsiz Render planında, uygulama 15 dakika kullanılmazsa "uyur" ve bir sonraki açılışta ilk yüklenme 20-30 saniye sürebilir. Bu normaldir, sorun değildir. Daha hızlı/kesintisiz olmasını isterseniz Render'da ücretli bir plana (aylık ~7$) geçebilirsiniz.

## 9. Telefonunuza ekleme

1. Render'ın verdiği linki telefonunuzda Safari (iPhone) veya Chrome (Android) ile açın.
2. Giriş ekranında Adım 4'te belirlediğiniz giriş kodunu yazıp girin.
3. **iPhone**: Paylaş simgesine (kare + ok) basın → **Ana Ekrana Ekle**.
   **Android**: Sağ üstteki üç noktaya basın → **Ana ekrana ekle**.

Artık telefonunuzda gerçek bir uygulama gibi görünen bir simgeniz olacak.

## 10. Yeni bir işletme ekleme (Ofis, İnşaat vb.)

Zeytinkule dışında bir ofis veya inşaat projesi eklemek için Neon/GitHub/Render'a tekrar dönmenize gerek yok — tamamen uygulama içinden yapılıyor:

1. Uygulamanın en üstündeki başlığa (işletme adının yazdığı yere) dokunun — **İşletme Seç** ekranı açılır.
2. **+ Yeni İşletme Ekle** deyin.
3. Bir isim yazın (örn. "Ofis 2", "İnşaat A") ve tipini seçin:
   - **Ofis / İnşaat (Gelir-Gider)** — Daireler bölümü olmayan, serbest gelir/gider takibi yapılan işletmeler için (ofisleriniz, inşaat projeleriniz).
   - **Site / Bina (Daireler)** — Zeytinkule gibi daire/aidat takibi olan bir bina daha eklemek isterseniz.
4. **Oluştur** deyin — yeni işletme hemen oluşur ve otomatik olarak ona geçersiniz.

Her işletmenin Giderler, Personel ve Raporlar bölümleri kendi verisiyle, birbirinden bağımsız çalışır. Ofis/İnşaat tipi işletmelerde Daireler yerine bir **Gelir** sekmesi bulunur — ortağınızın, abinizin ödediği paralar, kira veya satış gelirleri gibi kaynağı değişen gelirleri serbest bir açıklama yazarak (örn. "Ortak ödemesi - Ahmet Bey", "3 nolu daire kirası") tek tek kaydedebilirsiniz. İnşaat projelerinde masraflar da (malzeme/işçilik ayrımı yapılmadan) tek kalem "gider" olarak Giderler'den girilir.

---

## Sorun giderme

**Giriş yapamıyorum:** Render panelinde Environment sekmesindeki `ADMIN_PASSWORD` değerini kontrol edin, boşluk kalmadığından emin olun.

**"Sunucuya bağlanılamıyor" / sayfa hiç açılmıyor:** Render panelinde **Logs** sekmesine bakın, kırmızı hata mesajı varsa muhtemelen bir ortam değişkeni eksik veya yanlış girilmiş.

**Veriler görünmüyor / "Sunucuya bağlanılamıyor":** `DATABASE_URL` değerini tekrar kontrol edin — Neon panosundaki **Connect** penceresinden aldığınız bağlantı adresinin tamamını (baş ve sondan kesilmeden) kopyaladığınızdan emin olun.

**Asistan sekmesi çalışmıyor:** `ANTHROPIC_API_KEY` eksik, yanlış ya da hesapta bakiye yok olabilir. Diğer sekmeler bundan etkilenmez.

**Bir şeyi değiştirmek/güncellemek isterseniz:** Kod değişikliğini GitHub'daki dosyaya yükleyin (Adım 7'deki gibi) — Render bunu otomatik algılayıp uygulamayı birkaç dakika içinde yeniden yayınlar, hiçbir ek işlem gerekmez.

---

Herhangi bir adımda takılırsanız, hangi adımda olduğunuzu ve gördüğünüz hata mesajını (varsa ekran görüntüsüyle) paylaşın, birlikte çözelim.
