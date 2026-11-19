# WizzChat — topluluk sohbeti

Türkçe topluluk iletişimi için web uygulaması. Üyeler arkadaş ekleyip bire bir mesajlaşabilir, topluluk oluşturup davet bağlantısıyla arkadaşlarını ekleyebilir; metin ve ses kanalları, oda içi kamera yayını, profil düzenleme ve temel mesaj tepkileri bulunur. Hesap, topluluk, mesaj ve oturum bilgileri PostgreSQL'de tutulur. Ses ve kamera WebRTC ile katılımcılar arasında aktarılır.

## İnternette yayımlama (Render)

1. Bu klasörü bir GitHub deposuna yükle.
2. Render hesabında **New → Blueprint** seçip bu depoyu bağla.
3. Render, `render.yaml` ayarlarıyla web servisini mevcut `yanki-db` PostgreSQL veritabanına bağlar. Veritabanı aynı Render çalışma alanında bulunmalıdır. Dağıtım tamamlanınca `https://...onrender.com` adresini arkadaşlarınla paylaş.
4. Hesap oluşturmak için kullanıcı adı, e-posta adresi ve şifre gir. Girişten sonra topluluk oluşturabilir, davet koduyla katılabilir, metin/ses kanalları açabilir ve kamera yayını başlatabilirsin. Mikrofon ve kamera izni için HTTPS adresini kullan.

Ücretsiz servis bir süre kullanılmayınca uykuya geçebilir; ilk açılışın başlaması biraz sürebilir. Ücretsiz sunucu WebSocket sinyalleşmesini destekler. Bazı ağlarda WebRTC ses bağlantısı STUN ile kurulamayabilir; daha yüksek bağlantı başarısı için TURN servisi eklenmesi gerekir.

**Veritabanı notu:** Hesap tabloları `yanki_users` ve `yanki_sessions` adlarıyla mevcut veritabanında oluşturulur. Render ücretsiz veritabanlarını 30 gün sonra süresi dolacak şekilde sunar; hesapların bundan uzun süre korunması için Render'da veritabanı planını ücretli bir plana yükselt.

## Yerelde çalıştırma

Node.js 20 veya üstü ve bir PostgreSQL veritabanı gerekir. `DATABASE_URL` ortam değişkenini ayarla:

```sh
npm install
npm start
```

`DATABASE_URL` ortam değişkenini bir PostgreSQL veritabanına yönelt. Ardından `http://localhost:3000` adresini aç.

