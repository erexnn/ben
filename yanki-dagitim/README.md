# Yankı — sesli sohbet

Arkadaşlarınla davet koduyla sesli sohbet etmek için küçük bir web uygulaması. Arayüz Türkçedir; kullanıcılar e-posta, kullanıcı adı ve şifreyle hesap açar, profillerini düzenleyip fotoğraf ekleyebilir. Hesap, profil ve oturum bilgileri PostgreSQL'de tutulur. Ses WebRTC ile katılımcılar arasında aktarılır.

## İnternette yayımlama (Render)

1. Bu klasörü bir GitHub deposuna yükle.
2. Render hesabında **New → Blueprint** seçip bu depoyu bağla.
3. Render, `render.yaml` ayarlarıyla web servisini mevcut `yanki-db` PostgreSQL veritabanına bağlar. Veritabanı aynı Render çalışma alanında bulunmalıdır. Dağıtım tamamlanınca `https://...onrender.com` adresini arkadaşlarınla paylaş.
4. Render servisinin **Environment** bölümüne `GMAIL_USER` (gönderici Gmail adresin) ve `GMAIL_APP_PASSWORD` (Google uygulama şifresi) değerlerini ekle. İki adımlı doğrulama açık olan Google hesabından uygulama şifresi oluşturman gerekir. Ardından uygulamayı yeniden dağıt.
5. Hesap açarken e-postana gelen 6 haneli kodu gir. Giriş yaptıktan sonra oda oluşturabilir, davet bağlantısını kullanabilir ve oda içinden kamera yayınını başlatabilirsin. Mikrofon ve kamera izni için HTTPS adresini kullan.

Ücretsiz servis bir süre kullanılmayınca uykuya geçebilir; ilk açılışın başlaması biraz sürebilir. Ücretsiz sunucu WebSocket sinyalleşmesini destekler. Bazı ağlarda WebRTC ses bağlantısı STUN ile kurulamayabilir; daha yüksek bağlantı başarısı için TURN servisi eklenmesi gerekir.

**Veritabanı notu:** Hesap tabloları `yanki_users` ve `yanki_sessions` adlarıyla mevcut veritabanında oluşturulur. Render ücretsiz veritabanlarını 30 gün sonra süresi dolacak şekilde sunar; hesapların bundan uzun süre korunması için Render'da veritabanı planını ücretli bir plana yükselt.

**Gmail notu:** `GMAIL_APP_PASSWORD` normal Gmail şifren değildir. Google hesabında 2 Adımlı Doğrulama'yı açıp Uygulama Şifreleri bölümünden üret; bu değeri GitHub'a ekleme. Render'ın Environment bölümünde gizli değişken olarak sakla.

## Yerelde çalıştırma

Node.js 20 veya üstü ve bir PostgreSQL veritabanı gerekir. `DATABASE_URL` ortam değişkenini ayarla:

```sh
npm install
npm start
```

`DATABASE_URL` ortam değişkenini bir PostgreSQL veritabanına yönelt. Ardından `http://localhost:3000` adresini aç.

