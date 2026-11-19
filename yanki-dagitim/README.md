# WizzChat — topluluk sohbeti

Türkçe topluluk iletişimi için Discord tarzı web uygulaması. Üyeler arkadaş ekleyip özel mesajlaşabilir; kategorili topluluk kanalları açabilir; tepkiler kullanabilir, mesajlarını düzenleyebilir, dosya ekleyebilir ve topluluklarındaki mesajları arayabilir. Ses kanalları, mikrofon ve ekran paylaşımı WebRTC ile çalışır. Hesap, topluluk, mesaj, ek ve oturum bilgileri PostgreSQL'de tutulur.

## Mevcut işlevler ve sınırlar

- Arkadaş listesi, gelen/giden istekler ve bire bir mesajlar
- Topluluk davetleri, metin/ses kanalları ve kullanıcı tanımlı kanal kategorileri
- Mesaj arama, eski arama sonucuna gitme, kendi mesajını düzenleme ve emoji tepkileri
- PNG/JPG/WebP, PDF ve TXT ekleri (dosya başına 500 KB, mesaj başına toplam 540 KB)
- WebRTC ses, mikrofon denetimi ve ekran paylaşımı

Bu proje Discord hesabı, API'si veya servis altyapısıyla uyumlu değildir. Roller için izin matrisi, grup DM, thread/forum, bot ve uygulama dizini, etkinlik, gelişmiş moderasyon, bildirim ve Discord'un diğer servis özellikleri bu uygulamada bulunmaz. Ekler PostgreSQL'de tutulduğu için dosya boyutu özellikle sınırlıdır.

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

