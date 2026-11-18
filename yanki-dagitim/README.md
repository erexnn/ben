# Yankı — sesli sohbet

Arkadaşlarınla davet koduyla sesli sohbet etmek için küçük bir web uygulaması. Arayüz Türkçedir; kullanıcılar e-posta, kullanıcı adı ve şifreyle hesap açar, profillerini düzenleyip fotoğraf ekleyebilir. Hesap, profil ve oturum bilgileri PostgreSQL'de tutulur. Ses WebRTC ile katılımcılar arasında aktarılır.

## İnternette yayımlama (Render)

1. Bu klasörü bir GitHub deposuna yükle.
2. Render hesabında **New → Blueprint** seçip bu depoyu bağla.
3. Render, `render.yaml` ayarlarıyla web servisini mevcut `yanki-db` PostgreSQL veritabanına bağlar. Veritabanı aynı Render çalışma alanında bulunmalıdır. Dağıtım tamamlanınca `https://...onrender.com` adresini arkadaşlarınla paylaş.
4. Hesap açıp giriş yaptıktan sonra oda oluştur veya davet bağlantısını kullan. Mikrofon izni için HTTPS adresini kullan.

Ücretsiz servis bir süre kullanılmayınca uykuya geçebilir; ilk açılışın başlaması biraz sürebilir. Ücretsiz sunucu WebSocket sinyalleşmesini destekler. Bazı ağlarda WebRTC ses bağlantısı STUN ile kurulamayabilir; daha yüksek bağlantı başarısı için TURN servisi eklenmesi gerekir.

**Veritabanı notu:** Hesap tabloları `yanki_users` ve `yanki_sessions` adlarıyla mevcut veritabanında oluşturulur. Render ücretsiz veritabanlarını 30 gün sonra süresi dolacak şekilde sunar; hesapların bundan uzun süre korunması için Render'da veritabanı planını ücretli bir plana yükselt.

## Yerelde çalıştırma

Node.js 20 veya üstü ve bir PostgreSQL veritabanı gerekir. `DATABASE_URL` ortam değişkenini ayarla:

```sh
npm install
npm start
```

`DATABASE_URL` ortam değişkenini bir PostgreSQL veritabanına yönelt. Ardından `http://localhost:3000` adresini aç.

