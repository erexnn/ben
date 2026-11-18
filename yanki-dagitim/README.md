# Yankı — sesli sohbet

Arkadaşlarınla davet koduyla sesli sohbet etmek için küçük bir web uygulaması. Arayüz Türkçedir; ses WebRTC ile katılımcılar arasında aktarılır. Oda keşfi ve WebRTC sinyalleşmesi uygulama sunucusu üzerinden geçer.

## İnternette yayımlama (Render)

1. Bu klasörü bir GitHub deposuna yükle.
2. Render hesabında **New → Blueprint** seçip bu depoyu bağla.
3. Render, `render.yaml` ayarlarıyla `yanki-sesli-sohbet` web servisini oluşturur. Dağıtım tamamlanınca verilen `https://...onrender.com` adresini arkadaşlarınla paylaş.
4. Oda oluşturup davet bağlantısını paylaş. Mikrofon izni için HTTPS adresini kullan.

Ücretsiz servis bir süre kullanılmayınca uykuya geçebilir; ilk açılışın başlaması biraz sürebilir. Ücretsiz sunucu WebSocket sinyalleşmesini destekler. Bazı ağlarda WebRTC ses bağlantısı STUN ile kurulamayabilir; daha yüksek bağlantı başarısı için TURN servisi eklenmesi gerekir.

## Yerelde çalıştırma

Node.js 20 veya üstü gerekir:

```sh
npm install
npm start
```

Ardından `http://localhost:3000` adresini aç.
