# Vadum

**Solana Çevrimdışı Ödeme SDK'sı** · Solana Foundation Turkey Grants başvurusu için proje dokümanı

> **Proje adı: Vadum.** Latincede *geçit* — bir nehri, köprü olmadığı için sığından geçtiğin yer. Projenin tanımı bu: **değer, altyapının olmadığı yerden geçiyor.**
>
> Tagline: *"Value crosses where there's no bridge."*
>
> **İsim temizliği yapıldı (22 Ağu 2026):** npm `vadum` boş; `vadum.dev` ve `vadum.xyz` boş (`.com` kayıtlı); kripto/token, şirket/marka ve malware/APT taramalarında çakışma yok. GitHub org dolu — repo `tamerarda/vadum` olarak açılacak.
>
> Bu doküman ekip içi bilgilendirme içindir.

**Tarih:** 22 Ağustos 2026 · **Durum:** Fikir olgunlaştı, başvuru yazılmadı

> ✅ **Doğrulama turu — 22 Ağustos 2026.** Dokümandaki zamana duyarlı bütün iddialar (slot süresi, kira indirimi, deprecation durumu, hacim payı, hibe rakamları) kaynaklarından teyit edildi ve prior art taraması yapıldı. Değişen yerler aşağıda güncellendi; bölüm 8 yeni.

---

## 1. Tek cümlede

Solana üzerinde stablecoin ödemesi yapmanın bugün **her iki tarafın da aynı anda internete bağlı olmasını** zorunlu kılan yapısal kısıtını ortadan kaldıran açık kaynak bir SDK ve onun üzerine kurulmuş referans alıcı/satıcı uygulamaları.

Kısaca: **alıcının ödeme yapmak için internete ihtiyacı kalmıyor.**

---

## 2. Problem

### 2.1 Bugün nasıl çalışıyor?

Solana'nın standart ödeme protokolü **Solana Pay**'in iki modu var ve **ikisi de canlı bağlantı gerektiriyor**:

| Mod | Neden internet gerekiyor |
|---|---|
| **Transaction request** | Cüzdan, satıcının sunucusuna canlı bir HTTP çağrısı yapıp işlemi ondan alıyor |
| **Transfer request** | Cüzdanın ağdan taze bir *blockhash* çekmesi ve işlemi kendisinin ağa göndermesi gerekiyor |

### 2.2 Blockhash denen şey ve neden sorun

Solana'da her işlem, yakın geçmişteki bir bloğun kimliğini (`recentBlockhash`) taşımak zorunda. Bu kimlik **150 slot**, yani **yaklaşık bir dakika** sonra geçersiz oluyor. Bir dakikadan eski imzalanmış işlem ağ tarafından reddediliyor.

Bunun anlamı şu: bir işlemi "şimdi imzalayıp yarın gönderemezsin". Ağa bağlanamıyorsan taze blockhash de alamazsın, dolayısıyla geçerli bir işlem üretemezsin.

### 2.3 Kimler dışarıda kalıyor

Bağlantı olmadığı ya da çöktüğü her yerde stablecoin ödemesi **teknik olarak imkânsız**:

- **Afet bölgesi** — baz istasyonları düştüğünde
- **Metro, tünel, kapalı otopark, bodrum kat**
- **Stadyum, festival, konser** — hücrenin doyduğu kalabalık alanlar
- **Kırsal bölge ve seyyar satıcı** — şebekenin zayıf olduğu yerler
- **Kotası bitmiş hat, roaming'i olmayan turist, hattı olmayan çocuk**

### 2.4 Ve problem zamanla büyüyor

Bu artık bir tahmin değil. Slot süresi düşüşü **SIMD-0525** ile yönetiliyor ve dört adet 50ms kademe öngörüyor: 400 → 350 → 300 → 250 → 200.

**İlk kademe mainnet'te canlıya alındı: epoch 1020, 21 Ağustos 2026.** Ağın kuruluşundan bu yana ilk slot süresi düşüşü.

150 slotluk pencere doğrudan buna bağlı olduğu için blockhash ömrü de kısaldı:

| Slot süresi | 150 slotluk pencere | Durum |
|---|---|---|
| 400ms | ~60 sn | eski |
| **350ms** | **~52,5 sn** | **21 Ağu 2026'dan beri canlı** |
| 300ms | ~45 sn | sırada |
| 250ms | ~37,5 sn | sırada |
| 200ms | **~30 sn** | hedef |

Bu, başvurudaki "neden şimdi" sorusunun en güçlü cevabı — ve artık tarihli bir olgu:

> *İnsanlı QR turu (göster → tara → oku → onayla → imzala → göster → tara → gönder) gerçekte 15-25 saniye sürüyor. Geçerlilik penceresi dün daraldı ve üç kademe daha var.*

> ⚠️ **Ekip notu:** Validatörler, ağın skip rate'i belirli eşikleri aşarsa bir sonraki kademeye geçmemek üzere anlaşmış durumda. Yani takvim uzayabilir — "200ms şu tarihte gelecek" diye yazmayalım, "dört kademenin ilki canlı, üçü sırada" diyelim.

---

## 3. Çözüm: durable nonce

### 3.1 Ne olduğu

Solana'da 2020'den beri var olan ama **ödeme bağlamında hiç ürünleştirilmemiş** bir primitif: **durable nonce**.

Mantığı basit. `recentBlockhash` alanına, ağdan çekilen taze bir blockhash yerine, **zincirde bir hesapta saklanan bir değer** koyuyorsun. O değer kendiliğinden eskimediği için işlemin **son kullanma tarihi ortadan kalkıyor**.

### 3.2 Nasıl kurulur

Alıcı **bir kez, çevrimiçiyken** kendi kontrolündeki bir **nonce hesabı havuzu** açıyor:

- Hesaplar System Program'a ait, **nonce authority** alıcının kendisi
- Her hesap 80 bayt, kirası **geri alınabilir** (hesabı kapatınca iade)
- Kira şu anda hesap başına ~**0,00145 SOL**

> 💡 **İyi haber:** SIMD-0437 kabul edildi ve `lamports_per_byte` değerini 6960'tan 696'ya, yani **%90 aşağı** çekiyor. SIMD-0436'nın yerini aldı. Beş kademe: **6960 → 6333 → 5080 → 2575 → 1322 → 696.** Agave 4.2 mainnet feature aktivasyonu **17 Ağustos 2026 haftasında başladı.**
>
> ⚠️ **Ama bitmiş rakamı bugünkü rakam gibi sunmayalım.** Kademeler bağımsız feature gate'ler ve Anza her adımda state büyümesini izleyip duraklatabiliyor. Şu an **ilk kademedeyiz.** Doğru cümle: *"nonce hesabı kirası bugün ~0,00145 SOL; kabul edilmiş beş kademeli plan bunu ~0,00015 SOL'e indiriyor ve ilk kademe aktive edildi."* Havuz maliyeti düşüyor — ama düşme sürecinde.

### 3.3 Çevrimdışı imzalama

Havuz kurulduktan sonra alıcının telefonu, **hiçbir ağ bağlantısı olmadan** geçerli ve imzalı bir USDC transferi üretebiliyor. İşlemin yapısı:

1. **İlk talimat `AdvanceNonceAccount`** olmak zorunda (protokol kuralı) ve nonce authority'nin imzasını gerektiriyor
2. `recentBlockhash` alanına, hesapta saklı nonce değeri konuyor
3. Ardından `createAssociatedTokenAccountIdempotent` — satıcının USDC hesabı yoksa oluşturulsun diye (çevrimdışıyken var olup olmadığını bilemeyiz, bu talimat varsa hata vermiyor)
4. Ardından USDC transferi

### 3.4 Alıcının SOL tutmaması: fee payer satıcı

Solana'da işlem ücretini **fee payer** ödüyor ve fee payer ile diğer imzacılar farklı olabiliyor. Bu projede:

- **Fee payer = satıcı** (imzasını gönderirken ekliyor)
- **Nonce authority ve token sahibi = alıcı** (çevrimdışı imzalıyor)

Sonuç: **alıcı hiç SOL tutmuyor.** Yalnızca USDC tutuyor.

> **Mint-agnostic olduğumuzu başvuruda söyleyelim.** Yaptığımız şey teknik olarak herhangi bir SPL mint üzerinde `transferChecked` — USDC'ye özel hiçbir şey yok. Referans mint USDC (Solana stablecoin arzının ~%77'si), ama aynı kod **USDG** ve PYUSD ile de değişmeden çalışıyor. Hibeyi USDG'de ödeyen bir kuruma bunu söylemek bedava bir hizalanma.

Bu kritik bir onboarding kazancı. Hedef kullanıcı zaten SOL'ün ne olduğunu bilmiyor; ayrıca bakiyesi bittiğinde kuyruktaki bütün işlemlerin çökmesi hikâyenin en zayıf halkası olurdu. Nonce hesaplarının kirasını da bir sponsor veya STK fonlayabilir.

### 3.5 Dürüst olalım: birincil senaryoda nonce şart değil

**Bu bölüm başvuruda mutlaka olmalı.** Solana bilen bir hakem bunu ilk okuyuşta görür ve hazırlıksız yakalanmak, başvurunun en kolay ölme şeklidir.

5.5'te birincil senaryoyu "alıcı çevrimdışı, **satıcı çevrimiçi**" seçiyoruz. Ama satıcı çevrimiçiyse:

> satıcı taze blockhash çeker → QR #1'e koyar → alıcı çevrimdışı imzalar → QR #2 → satıcı 20 saniyede gönderir

**Nonce hesabı yok, kira yok, `AdvanceNonce` yok, deprecation riski yok.** Üstelik işlemi satıcı kurduğu için QR #2 yalnızca alıcının imzası olabilir — **64 bayt.** Yani 6.1'deki bütün QR yoğunluk problemi buharlaşıyor.

Cevabımız "nonce zorunlu" değil. Cevabımız şu: **nonce üç somut şey satın alıyor ve üçüncüsü zamanla büyüyor.**

| Nonce ne satın alıyor | Taze blockhash yolunda durum |
|---|---|
| **Protokol düzeyinde at-most-once** | **Hiç yok.** Aynı taze blockhash'e iki işlem imzalanabilir ve bakiye yeterse **ikisi de düşer.** Nonce'ta protokol en fazla birinin düşmesini garanti ediyor (5.1) |
| **Sınırsız gönderim penceresi** | 52,5 saniye. Satıcının bağlantısı *yok* değil *kararsız* ise bu yetmiyor; işlem ölürse müşteri çoktan gitmiş oluyor |
| **Slot düşüşüne dayanıklılık** | Pencere 30 saniyeye inerken insan-döngüde tur 15-25 saniye (2.4). Pay kalmıyor |

Üçüncüsünün anlamı şu: **nonce bugün opsiyonel, 200ms slotta yük taşıyan parça oluyor.** Bir yıl önce bu proje gereksizdi, bir yıl sonra zorunlu olacak — tam ortasındayız.

### 3.6 Sonuç: SDK iki yollu olacak

Tek yol seçmek yerine ikisini **tek arayüz arkasına** alıyoruz:

| Yol | Ne zaman | Bedeli |
|---|---|---|
| **Taze blockhash** | Satıcının bağlantısı sağlam, gönderim saniyeler içinde | Kira yok, hesap yok, küçük QR — ama çift harcamaya karşı **hiçbir** protokol koruması yok |
| **Durable nonce** | Bağlantı kararsız, gönderim gecikmeli, ya da at-most-once garantisi isteniyor | Nonce hesabı + kira + daha büyük QR |

Üç kazanç birden:

1. **Daha dürüst** — hakemin soracağı soruyu biz soruyoruz
2. **Daha iyi ürün** — satıcının bağlantı kalitesine göre doğru yol seçiliyor
3. **6.3'teki deprecation riskini tamamen kapatıyor** — durable nonce bir gün giderse taze blockhash yolu ayakta kalıyor

---

## 4. Akış

```
┌─ ALICI (çevrimdışı) ─────────┐        ┌─ SATICI ──────────────────┐
│                              │        │                           │
│                              │◀── 1 ──│ QR #1: adres + tutar      │
│                              │        │        + fee payer pubkey │
│ 2. Çevrimdışı imzalar:       │        │                           │
│    AdvanceNonce              │        │                           │
│    + createATAIdempotent     │        │                           │
│    + USDC transfer           │        │                           │
│                              │        │                           │
│ QR #2: imzalı işlem ─── 3 ──▶│        │ 4. Okur ve ÇEVRİMDIŞI     │
│                              │        │    doğrular:              │
│                              │        │    · imza geçerli mi      │
│                              │        │    · tutar doğru mu       │
│                              │        │    · mint USDC mi         │
│                              │        │    · alıcı adresi BEN miyim│
│                              │        │                           │
│                              │        │ 5. Yerel kuyruğa alır     │
│                              │        │                           │
│                              │        │ 6. Bağlantı gelince:      │
│                              │        │    fee payer imzasını     │
│                              │        │    ekler, toplu gönderir  │
└──────────────────────────────┘        └───────────────────────────┘
```

**Akış iki QR'dır** — bu demo videosunda net görünmeli. Önce satıcı ne istediğini gösterir, sonra alıcı imzalı işlemi gösterir.

İşlem ağa düştüğü anda **nonce ilerler** ve aynı nonce değerine karşı imzalanmış bütün diğer işlemler protokol düzeyinde geçersizleşir.

> Yukarıdaki şema **durable nonce yolunu** gösteriyor. Taze blockhash yolunda (3.6) akış aynı kalıyor, yalnızca QR #1 nonce yerine taze bir blockhash taşıyor ve adım 2'deki `AdvanceNonce` düşüyor. Demo videosunda gösterilecek olan nonce yolu — çünkü uçak modundaki iki telefon hikâyesi orada.

---

## 5. Tehdit modeli — ve neyi çözmediğimiz

Bu bölüm başvurunun en önemli kısmı. Riski biz yazarsak olgun görünürüz; hakem kendisi bulursa proje ölür.

### 5.1 Protokolün garantisi ne, ne değil

Nonce ilerlediğinde aynı değere karşı imzalanmış işlemler geçersizleşiyor. Ama bu garantinin **doğru okunuşu** şu:

> **Protokolün garantisi "en fazla biri düşer"dir. "Hiçbir satıcı zarar etmez" değildir.**

### 5.2 Çok satıcılı çift harcama

Kötü niyetli bir alıcı aynı nonce'a karşı **farklı satıcılara farklı işlemler** imzalayabilir:

- A satıcısına 200 TL, B'ye 200 TL, C'ye 200 TL
- Her biri kendi cihazında imzayı, tutarı ve kendi adresini doğrular — **hepsi geçerli görünür**
- Sonra yalnızca biri zincire düşer
- Diğer ikisi malı vermiş, parayı alamamıştır

**Kendi cüzdan uygulamamızın dürüst olması bunu engellemez**, çünkü saldırgan kendi imzalayıcısını yazabilir. İstemci tarafındaki hiçbir kısıt burada bağlayıcı değildir.

Nonce havuzu bu saldırının kapasitesini de büyütür: N nonce, N eşzamanlı geçerli ödeme demektir. **Havuz büyüklüğü ile risk arasındaki bu gerilim bilinçli bir ürün kararıdır ve açıkça yazılmalıdır.**

### 5.3 Kartla analoji — ve asimetri

Kart ağları bu riski kırk yıldır **offline authorization floor limit** ile yönetiyor: belirli tutarın altında terminal çevrimdışı onaylıyor, riski kabul ediyor.

Ama bir asimetri var ve gizlenmemeli: **kartta chargeback ve kimlik var, zararın bir kısmını ihraççı yiyor. Burada rücu yok, zararı satıcı yiyor.**

### 5.4 Bizim sınırlandırma araçlarımız

Projenin iddiası "bu riski çözdüm" değil, "kart ağlarının aynı riski yönettiği araçlarla sınırlandırdım":

| Araç | Ne yapıyor |
|---|---|
| **Fiş başına tutar tavanı** | Tek bir çevrimdışı ödemenin azami büyüklüğü |
| **Kuyruk maruziyeti üst sınırı** | Satıcı cihazının aynı anda taşıyabileceği toplam çevrimdışı tutar |
| **Kısa gönderim penceresi** | Kuyruktaki işlemin ne kadar sürede gönderilmesi gerektiği |
| **Birincil senaryo seçimi** | Aşağıya bakınız — en etkili araç bu |

### 5.5 Birincil senaryo: alıcı çevrimdışı, satıcı çevrimiçi

**Bu, tehdit modelinin asıl cevabıdır.**

Satıcı çevrimiçiyse gönderim penceresi **saniyelere** iner, çok satıcılı saldırı pratikte ekonomik olmaktan çıkar, üstelik satıcı alıcının bakiyesini de kontrol edebilir.

Ve özgünlük kaybolmaz, tam tersine netleşir: standart Solana Pay'de **alıcının cüzdanı ağa çıkmak zorundadır**. Bu modelde alıcı ağa hiç dokunmaz.

"Her iki taraf da çevrimdışı" senaryosu **ikincil mod** olarak, çok daha düşük tavanla sunulur.

### 5.6 Açıkça çözmediğimiz şey

Tamamen çevrimdışı bir satıcı, alıcının kasasının fonlu olduğunu doğrulayamaz — bunun için ışık istemci (light client) gerekir ve mobil cihazda pratik değildir.

Başvuruda geçmesi gereken cümle:

> *"Tam çevrimdışı bakiye doğrulaması ışık istemci olmadan teorik olarak imkânsızdır. Bunu çözdüğümüzü iddia etmiyoruz; tutar tavanı, kuyruk sınırı ve gönderim penceresiyle sınırlandırıyoruz."*

Bu cümle bizi zayıf değil, **yetkin** gösterir.

### 5.7 Kötü niyetli satıcı: talimat enjeksiyonu

Şimdiye kadar hep alıcıyı saldırgan varsaydık. Ters yön de var ve dokümanda eksikti.

QR #1'i **satıcı** üretiyor. İçine fazladan talimat koyabilir:

- **`Approve` (delegate)** — en tehlikelisi. Alıcının USDC'sine sonradan, istediği zaman erişim verir
- **`SetAuthority`** — token hesabının sahipliğini değiştirir
- **`CloseAccount`** — hesabı kapatıp bakiyeyi başka yere yollar
- Ya da sessizce ikinci bir `transfer`

Çevrimdışı alıcı zincir durumunu göremez — ama **imzaladığı şeyi görebilir.** İki katmanlı savunma:

1. **Katı beyaz liste.** İmzalayıcı tam olarak şunu kabul eder: `{AdvanceNonce?, createATAIdempotent?, transferChecked}` — kaynak alıcı, tek hedef, tek mint. Listede olmayan her talimat reddedilir. `transferChecked` seçilmesi de bilinçli: mint ve ondalık işlemin içine bağlanıyor, çevrimdışı doğrulanabiliyor
2. **Daha iyisi — satıcı hiç işlem göndermesin.** QR #1 kompakt bir **niyet** taşısın (hedef + tutar + mint + fee payer + blockhash ya da nonce), alıcının cihazı işlemi **kanonik olarak kendisi kursun.** O zaman saklanacak bir şey kalmıyor, üstelik QR #1 de küçülüyor

> Bu endişe bizim icadımız değil: SIMD tartışma #415'te core geliştiriciler de *"cüzdanlar güvenilmeyen nonce işlemlerini imzalamayı kısıtlamalı"* diye kaydetti (6.3). Başvuruda buna atıf yapmak, tehdidi bağımsız bir kaynakla doğrulamak demek.

### 5.8 QR değiştirme

Çevrimdışı alıcı, QR'daki hedef adresin gerçekten o satıcıya ait olduğunu **doğrulayamaz.** Zincire bakamaz, isim kaydı yok.

Bu yeni bir saldırı değil: Çin ve Hindistan'daki QR ödeme sistemlerinde satıcının çıkartmasının üzerine saldırganın kendi QR'ını yapıştırması yaygın bir dolandırıcılık. Bizde de aynen geçerli ve gizlenmemeli.

Hafifletme: satıcının **imzalı kimliği** QR #1'de taşınsın, alıcının uygulaması daha önce ödeme yaptığı satıcıları hatırlasın ve yeni bir satıcıda uyarı göstersin. Tam çözüm değil — kart dünyasında da tam çözümü yok.

### 5.9 Çevrimdışı nonce desenkronizasyonu

Bu bir saldırı değil, **ürünün sert kullanılabilirlik tavanı** — ve dokümanda net yazılmalı.

İşlem zincire düştüğünde nonce ilerliyor. Ama alıcı hâlâ çevrimdışıysa **yeni nonce değerini bilemez.** Sonuç tek cümlede:

> **N hesaplık havuz = çevrimiçi olmadan en fazla N ödeme.**

5.2'de bunu risk kapasitesi olarak yazmıştık; asıl önemlisi bu. İki operasyonel sonucu var:

1. **Yerel "harcandı" durumu kritik.** Alıcının uygulaması bir nonce'u kullanınca yerel olarak işaretlemeli. Uygulama silinir ya da çökerse bu bilgi kaybolur ve alıcı ölü işlemler imzalamaya başlar. **Teslimat #4'ün en zor kısmı bu** — QR değil
2. **Birincil senaryoda zarif bir çözümü var.** Satıcı çevrimiçi: işlem düştükten sonra **ilerlemiş nonce değerini bir QR ile alıcıya geri verebilir.** Alıcı ağa hiç dokunmadan hesabı yeniden kurar. Satıcı yanlış değer verirse bir sonraki işlem geçersiz olur — yani **güvenli başarısız oluyor**, fon riski yok

İkincisi, "satıcı çevrimiçi" tercihini bir taviz olmaktan çıkarıp mimarinin özgün parçasına dönüştürüyor.

---

## 6. Teknik detaylar

### 6.1 İşlem boyutu ve QR — ölçülecek, iddia edilmeyecek

Kaba hesap:

| Bileşen | Bayt |
|---|---|
| 2 imza (+ sayaç) | ~129 |
| Mesaj başlığı | 3 |
| ~10-11 hesap anahtarı | ~325-355 |
| Nonce değeri | 32 |
| 3 talimat | ~55-60 |
| **Toplam** | **~575-600** |

**Address Lookup Table (ALT) sanıldığı kadar kazandırmıyor**, çünkü:

- **İmzacılar lookup table'a giremez** — fee payer (satıcı) ve nonce authority (alıcı) sabit kalmak zorunda
- Alıcının nonce hesabı ve kaynak token hesabı, satıcıya ait ortak bir tabloda olamaz

Gerçekçi kazanç 4-5 hesap → **~455 bayt**. base45 ile alphanumeric QR moduna kodlanınca ~685 karakter, EC seviyesi M'de yaklaşık **QR versiyon 18-20**.

> ⚠️ **Bunlar tahmin. Başvuruda sayı iddia etmiyoruz — ölçümü teslimat kalemi yapıyoruz:** "gerçek koşullarda (ucuz Android kamera, güneş altında, çizik ekran) ölçülmüş QR versiyonu ve okuma başarı oranı raporlanacak."
>
> **Yedek plan:** sığmazsa iki QR'a bölme veya animasyonlu QR.

**Bir itirazı baştan kapatalım:** Agave 4.2 ile gelen **SIMD-0296 / SIMD-0385** işlem boyutu tavanını 1.232 bayttan **4.096 bayta** çıkardı (yalnızca yeni v1 formatında; legacy ve v0 eski tavanda kalıyor). Hakem "işlem limiti zaten büyüdü ya" diyebilir. Cevap: **bağlayıcı kısıt 1.232 bayt değil, QR yoğunluğu.** Daha büyük işlem, ucuz bir Android kamerayla güneş altında okunabilir bir QR demek değil. Bu yüzden boyut hedefimiz değişmiyor.

### 6.2 Neden base45

QR kodun **alphanumeric modu** base64'ü desteklemiyor (küçük harf yok). base45 tam olarak QR alphanumeric moduna göre tasarlandı (AB dijital COVID sertifikalarında kullanıldı) ve byte moduna göre belirgin şekilde daha yoğun.

### 6.3 Nonce sağlayıcısı soyutlaması — ve halef formatla hizalanma

Solana'nın resmî dokümantasyonu durable nonce sayfasında **"gelecek bir sürümde kullanımdan kaldırılabilir"** uyarısı taşıyor ve **SIMD tartışma #415**'e yönlendiriyor. Ayrıca 6 Ağustos 2026 changelog'una göre geliştirme aşamasındaki **`ed25519-programmatic-signer`** programı, zincirde duran durable nonce implementasyonunun **SPL halefi** olarak kendi nonce implementasyonunu ekledi.

**#415'i açıp okuduk ve içerik beklenenden çok daha iyi çıktı.** Bu bir *kaldırma* önerisi değil, bir **sarmalama** önerisi: "Nonce Payload Transaction". Eski nonce işlemini bir zarfa alıyor; zarfın içinde şunlar var:

- **harici bir fee-payer**
- **taze bir blockhash**
- compute budget seçenekleri
- tüm mesaj üzerinde bir imza

Yani önerilen halef formatın şekli, bizim akışımızın birebir aynısı: **alıcı içerdeki nonce işlemini çevrimdışı imzalar; gönderim anında çevrimiçi olan taraf fee-payer'ı ve taze blockhash'i ekler.** Bizde zarfı kuracak olan zaten satıcı — çünkü gönderen o ve tanımı gereği çevrimiçi.

Üç sonuç:

1. **Bu bir risk değil, hizalanma.** Başvuruda "protokolün gittiği yön tam olarak bu topoloji, referans implementasyon buna hazır çıkıyor" diye yazılmalı
2. #415'in bağımlılığı **SIMD-0296** (büyük işlemler) idi; o Agave 4.2 ile geldi. Yani bağımlılık temizlendi, öneri ilerleyebilir
3. Tartışmada core geliştiricilerin kaydettiği bir endişe: **"cüzdanlar güvenilmeyen nonce işlemlerini imzalamayı kısıtlamalı."** Bu, imzalayıcıda katı bir talimat beyaz listesi demek. Bağımsız olarak core tarafından da dile getirilmiş olması, bunu teslimat kalemi yapmamız için iyi bir gerekçe

> ⚠️ **İki ayrı iddiayı karıştırmayalım.** Hizalanma argümanı *topoloji* hakkında, *API kararlılığı* hakkında değil. #415 henüz kabul edilmiş değil (aktif tartışma) ve kendini "ileride sunsetting'i mümkün kılan, geriye dönük uyumlu yol" diye tanımlıyor. Bugünkü `AdvanceNonceAccount` çağrısının ömrü sonsuz değil.
>
> **Bu yüzden nonce sağlayıcı soyutlaması teslimat #1'in içinde yerinde kalıyor.** Başvurudaki doğru cümle: *"gittiği yön bizim yönümüz — yine de arayüz arkasına aldık."*
>
> Zamanlama açısından riskimiz düşük: Solana'da bir özelliğin kaldırılması SIMD + feature gate + aktivasyon + ekosistem göçü demek; aylar değil yıllar. Üstelik System Program nonce'u bugün üretimde — kurumsal saklama sağlayıcıları (DFNS, Fordefi) çevrimdışı imzalama akışlarını buna dayandırmış durumda. Bu bir **bakım riski, inşa riski değil.**

> ⚠️ **Bir de şuna hazır olalım:** #415, nonce işlemlerinin sorununu "**hiçbir TTL'i yok, çalıştırılana kadar geçerli**" diye tanımlıyor ve ücretsiz düşen doğrulamaları bir spam vektörü sayıyor. Yani bizim ürün özelliğimiz, protokolün gözünde bir maliyet. Hakem sorarsa cevabımız hazır olmalı: **TTL'i biz zaten ürün seviyesinde gönderim penceresiyle koyuyoruz** (bkz. 5.4).

> Ek not: 2022'deki dört saatlik ağ kesintisi durable nonce işlemlerindeki bir hatadan kaynaklanmıştı. Hakemin kafasında bu primitif "kırılgan" çağrışımı yapabilir — tek cümleyle biz açmalıyız, hakemin hatırlamasını beklememeliyiz.

### 6.4 Zincir üstü program yok

**v1'de kullanıcı fonu tutan yeni bir Solana programı yazmıyoruz.** Sadece mevcut System Program ve Token Program talimatlarını kullanıyoruz.

Sonucu büyük: **güvenlik denetimi (audit) gerekmiyor.** Mikro-hibe ölçeğinde bu, projeyi finanse edilebilir kılan şey.

---

## 7. Neden Solana

⚠️ **Dikkat — burada kolay bir tuzak var ve ona düşmemeliyiz.**

"Durable nonce Solana'ya özgüdür" demek **geri teper**. Çünkü Ethereum ve EVM zincirlerinde **işlemler zaten hiç sona ermez** — belirli bir account nonce'una imzalanmış işlem, o nonce harcanana kadar süresiz geçerlidir. Yani çevrimdışı imzalama EVM'de varsayılan davranıştır.

Solana'nın durable nonce'a ihtiyaç duymasının sebebi tam olarak Solana işlemlerinin sona ermesi. Yani durable nonce bir **avantaj değil, Solana'ya özgü bir kısıtın etrafından dolaşma yöntemi.** EVM bilen bir hakem bunu ilk okuyuşta görür.

**Gerçek ve savunulabilir "neden Solana" şu beş ayak. İlk ikisi EVM itirazının doğrudan cevabı ve en güçlüleri — dokümanda eksiktiler:**

1. **EVM'de head-of-line blocking var, Solana'da yok.** EVM'de çevrimdışı imzaladığın işlem hesap nonce'u `k`'yı tutar ve `k` zincire düşene kadar o cüzdanın **sonraki bütün işlemleri kilitlenir.** Yani bekleyen tek bir çevrimdışı ödeme, kullanıcının bütün on-chain hayatını dondurur. Solana'da nonce **ayrı bir hesap** — bekleyen ödeme alıcının normal işlemlerini hiç engellemiyor. *"EVM'de bu zaten bedava"* itirazının cevabı tam olarak bu
2. **Fee payer ayrımı native.** Alıcının hiç SOL tutmaması (3.4) Solana'da protokol özelliği; fee payer ile diğer imzacılar farklı olabiliyor. EVM'de aynı şey için ERC-4337 + paymaster altyapısı gerekiyor — yani ekstra bir sistem, ekstra güven varsayımı. Onboarding hikâyemizin tamamı buna dayanıyor ve bu gerçekten Solana'ya özgü
3. **Cent altı işlem ücreti.** İki dolarlık bir çevrimdışı ödemeyi zincire yazmak Ethereum L1'de ödemenin kendisinden pahalıya gelir. Küçük tutarlı çevrimdışı ödemeyi ekonomik kılan tek şey bu
4. **Hacim burada.** Solana, ayarlanmış stablecoin **transfer hacminde** en büyük paylardan birini taşıyor — Şubat 2026 itibarıyla ~%35,5, iki yıl önce %2,6 idi
5. **Kira maliyeti düşüyor** (SIMD-0437, beş kademede %90; ilk kademe aktive edildi) — nonce havuzu gitgide ucuzluyor

> ⚠️ **Ekip notu — hacim rakamında dikkat.** Kaynaklar ciddi şekilde ayrışıyor ve metrik karıştırılırsa yakalanırız. **Transfer hacmi payı** ile **arz payı** aynı şey değil: Solana stablecoin *arzının* yalnızca ~%5'ini taşıyor ama *transfer hacminin* üçte birinden fazlasını. Başvuruda tek bir rakam, tek bir metrik adı ve tek bir tarih yazalım; göndermeden önce Artemis'ten teyit edip kaynağı dipnot verelim. Bizim argümanımız zaten hacim *payı* değil, **küçük tutarlı ödemenin ekonomik olması** — yani asıl ayak 3, ve asıl fark ayak 1 ile 2.

---

## 8. Prior art — ne var, ne yok

> **Tarandı: 22 Ağustos 2026.** Kapsam: web araması, GitHub arama motorları, Solana docs + changelog, SIMD tartışmaları, akademik arama. **Taranmayan:** hackathon proje arşivleri (Colosseum dizini, Devpost). Başvurudan önce oraya da bakılmalı — bir rakip en çok orada saklanır.

### 8.1 Solana'da: ürünleşmiş rakip yok

| Ne | Durum |
|---|---|
| **Zypp** (`Coding-With-Josh/zypp`) | Kendini "Solana destekli ilk offline-first kripto ödeme protokolü" diye tanımlıyor. BLE / NFC / proximity, shake-to-send. Ama **7 commit, 0 yıldız, 0 fork**; durable nonce'tan hiç bahsetmiyor, çift harcama mekanizması tanımlı değil, güvenlik cevabı "uçtan uca şifreleme" — ki bu işlem geçerliliğiyle ilgisiz bir cevap. Taşıma katmanına odaklı erken prototip. **Rakip değil, ama başvuruda mutlaka anılmalı** — hakem bulacak |
| `helius-labs/durable-nonce`, `0xproflupin/solana-durable-nonces` | Kütüphane ve rehber. Nonce sıhhi tesisatı çözülmüş, ödemeye çevrilmemiş |
| Chainstack / QuickNode rehberleri, Solana `offline-transactions` kursu | Dokümantasyon; airgap imzalama bağlamında |
| **DFNS, Fordefi** | Durable nonce'u **üretimde** kullanıyorlar: kurumsal saklama, politika kontrolleri, gecikmeli gönderim. Primitifin üretim kalitesinde olduğunun kanıtı — ama ödeme değil |
| **Solana Pay** | Çevrimdışı mod **yok** |
| `solana-labs/solana` #6872, #34453 | Eski CLI çevrimdışı imzalama issue'ları. Paper wallet / airgap; ödeme değil |
| **Solana Mobile Seeker** | Seed Vault TEE tabanlı; anahtar saklamada "offline resilience" sağlıyor, çevrimdışı ödeme değil. Ama donanım güven kökü bir Solana telefonunda hazır duruyor — v3 yönü |

**Sonuç: "durable nonce ödeme bağlamında hiç ürünleştirilmemiş" iddiası ayakta.** Başvuruda bunu "aramada bulunamadı" diye değil, *"şu üç yerde şunu aradık, çıkan tek şey bu"* diye yazalım.

### 8.2 Solana dışında: alan olgun, literatür derin

Bu on yıllık, ticari oyuncusu ve patenti olan bir alan. Bilmediğimizi belli edersek naif görünürüz.

| Kaynak | Neden önemli |
|---|---|
| **Crunchfish Digital Cash** | Bankalar ve CBDC için ticari çevrimdışı ödeme platformu: secure element (veya sanal SE), izole runtime, rollback korumalı şifreli depolama, sıralama + son kullanma kuralları, gönderen tarafta zorunlu bakiye limitleri. Ve kritik olan: **satıcı tarafı "yalnızca-alıcı çevrimdışı cüzdan".** Yani 5.5'teki birincil senaryo tercihimizi bağımsız olarak doğruluyorlar |
| **Fed FEDS Note (Ağu 2024), "Offline Payments: Implications for Reliability and Resiliency"** | Otoriter ve atıf yapılabilir; floor-limit argümanını bizim yerimize kuruyor |
| *Secure Wallet-Assisted Offline Bitcoin Payments with Double-Spender Revocation* | En yakın akademik ata: secure element + çift harcayanın ifşası |
| *PayOff*, *Offline Digital Euro (Groth-Sahai)*, *CBDC Offline Payments using a Secure Element*, SoK: *Design Space of Digital Payment Systems* | CBDC çevrimdışı ödeme tasarım uzayı |
| ABD patentleri **10810581**, **11842333** | Alan ticari olarak patentlenmiş. Açık kaynak araştırmaya engel değil; olgunluk göstergesi |

**Literatürün iki ortak kanısı — ikisi de bizim lehimize:**

> Çevrimdışı ödemede en zor problem çift harcamadır ve gerçek cevabı **kurcalamaya dirençli donanımdır.**
>
> **"Aralıklı çevrimdışı" (intermittently offline) tasarımlar en uygulanabilir olanlar sayılır.**

İkincisi tam olarak 5.5'teki tercihimiz. Başvurudaki çerçeve şu olmalı:

> *"Bu bilinen-zor bir problem ve bilinen cevabı secure element. Onu çözdüğümüzü iddia etmiyoruz — literatürün ve kart ağlarının aynı riski yönettiği araçlarla sınırlandırıyoruz. Yeni olan tek şey: Solana'nın kendi primitifleriyle aralıklı-çevrimdışı vakasına ilk kez ulaşmak."*

---

## 9. Teslim edilecekler

Kapsam bilinçli olarak dar tutuldu. 4-6 haftalık bir iş.

**Önceki taslakta sekiz kalem vardı; beşe indirildi.** Ortalama $3.452'lik bir mikro-hibede sekiz teslimat + iki referans uygulama + video inandırıcı değil. Hiçbir şey silinmedi — kalemler birleştirildi ve iki gerçek eksik eklendi (imzalayıcı beyaz listesi, insan-döngüde süre ölçümü).

| # | Teslimat | İçerdiği |
|---|---|---|
| 1 | **Çekirdek SDK** — iki yollu işlem kurma | Taze blockhash ve durable nonce yollarının tek arayüz arkasında birleşmesi (3.6); nonce havuzu kurulumu, yenileme, kapatma ve kira iadesi; nonce sağlayıcı soyutlaması (6.3) |
| 2 | **Güvenli çevrimdışı imzalayıcı** | Ağsız işlem kurma ve imzalama; **katı talimat beyaz listesi** ve niyetten kanonik kurma (5.7); alıcı onay ekranı |
| 3 | **QR taşıma katmanı + ölçüm raporu** | base45 kodlama/çözme; ucuz Android'de ölçülmüş QR versiyonu ve okuma başarı oranı; **insan-döngüde tur süresi dağılımı** — kaçı 52,5 sn'yi, kaçı 30 sn'yi aşıyor (2.4) |
| 4 | **Satıcı kuyruğu + başarısızlık UX'i** | Çevrimdışı doğrulama, yerel kuyruk, fee payer imzası, toplu gönderim; gönderim patladığında satıcı ne görüyor; alıcı tarafında nonce desenkronizasyonu (5.9). **Operasyonel olarak en zor kısım bu** |
| 5 | **Referans demo + spesifikasyon** | İki telefon, uçak modu, ödeme geçiyor — video; ve başkalarının üzerine inşa edebileceği spesifikasyon dokümanı |

> **Ekip notu:** Teslimat #3'teki asıl kanıt QR versiyonu değil, **süre dağılımı.** "Turların %X'i 30 saniyeyi aşıyor" diyen tek bir grafik, projenin gerekliliğini ampirik olarak kanıtlıyor ve başvurunun en somut teknik çıktısı o olacak.

---

## 10. Hibe bağlamı

**Program:** Solana Foundation Turkey Grants (Superteam Earn üzerinden)

| Parametre | Değer (22 Ağu 2026'da sayfadan teyit edildi) |
|---|---|
| Tutar | **10.000 USDG'ye kadar**, ortalama **$3.452** |
| Şimdiye kadar | **$86.300**, **25** kişi |
| Dönüş süresi | ~1 hafta |
| Koşul | **Türkiye'de olmak** + blockchain geliştirme deneyimi |
| Referans projeler | sol4k, postgrechain, hub3ee, feed_protocol, choizzy_io — `/references` sayfasında teyitli |

> ✅ **Ödeme birimi: USDG — ilk taslak doğruymuş.** Solana Foundation'ın bölgesel hibeleri Superteam Earn'de "up to $10k in **USDG**" diyor (USA ve UAE sayfalarında açıkça yazılı). Türkiye sayfasının jenerik "USD" göstermesi yanıltıcı. postgrechain'in $3.000'ı USDC olarak alması daha eski bir döneme ait.
>
> **Ölçek okuması:** 25 kişiye ortalama $3.452 — bu program mütevazı, bitirilebilir işleri fonluyor. Baktıkları asıl soru "bu kişi bitirir mi". Bu, kapsamı dar tutma kararımızı doğruluyor.

**Kategoriler:**

- **Payments** — mekanizması doğrudan oturuyor
- **Cause-driven building / daha kapsayıcı finansal sistem** — afet bölgesi ve bağlantısı kopmuş nüfus senaryosu üzerinden **zorlanmadan** oturuyor

**Önemli:** Hibe *Türkiye'deki kişiye* veriliyor, *Türkiye hakkında projeye* değil. Yani projenin Türkiye'ye özgü olma zorunluluğu yok — ama afet senaryosu bizim için doğal bir anlatı.

**Konumlanma:** Açık kaynak kamusal fayda. Başkalarının üzerine ödeme uygulaması inşa edebileceği bir SDK ve referans implementasyon. Kendi başına ticari bir ürün değil.

---

## 11. Yol haritası: v2 — zaman kilitli kasa

Tehdit modelindeki "alıcı, satıcı işlemi göndermeden parayı çevrimiçi harcar" saldırısını **tamamen kapatan** aşama:

Alıcı fonunu bir **kasa PDA'sına** kilitler, çekim zaman gecikmelidir (örn. 24 saat). O zaman satıcı işlemi gönderene kadar fon kaçırılamaz.

**Ama kapatmadığı şey:** çok satıcılı çift harcama. Çünkü çevrimdışı satıcı zincir durumunu doğrulayamaz.

**Neden ayrı aşama:** zincir üstü program yazmayı, custody'yi ve güvenlik denetimini gerektiriyor. Yani **ayrıca finanse edilmesi gereken** bir sonraki adım — mikro-hibe kapsamına sığmaz.

### Değerlendirilen ama ertelenen alternatif mimari

Ekip bilsin diye: durable nonce yerine **"kilitli kasa + imzalı fiş (voucher)"** mimarisi de değerlendirildi. Orada alıcı çevrimdışıyken bir transaction değil, kısa bir imzalı mesaj üretiyor; satıcı onu zincire itfa ediyor; aynı sıra numarasına iki fiş imzalanırsa bu kriptografik dolandırıcılık kanıtı oluyor ve teminat kesiliyor (*equivocation slashing*).

Bu mimari çok satıcılı çift harcamayı **ekonomik olarak** çözüyor, durable nonce deprecation riskini tamamen ortadan kaldırıyor ve QR yükünü ~150 bayta indiriyor.

**Neden v1 değil:** zincir üstü program, custody ve denetim gerektiriyor. Mikro-hibe ölçeğinde finanse edilemez. v2'nin doğal hedefi bu olabilir.

---

## 12. Başvurudan önce cevaplanması gerekenler

| # | Soru | Neden önemli | Durum |
|---|---|---|---|
| 1 | Gerçek işlem boyutu ve QR versiyonu **ölçülmeli** | Başvurudaki en somut teknik kanıt bu olacak | açık |
| 2 | 200ms slot aktivasyon durumu | "Problem büyüyor" argümanının dayanağı | ✅ **kapandı** — SIMD-0525, ilk kademe epoch 1020 / 21 Ağu 2026 canlı (bkz. 2.4) |
| 3 | ALT tasarımı: hangi hesaplar gerçekten sıkıştırılabilir | Boyut hesabını doğrudan etkiliyor | açık |
| 4 | Nonce havuzu büyüklüğü ↔ risk maruziyeti dengesi | Sayı olarak ilan edilmeli | açık |
| 5 | Başarısızlık UX'i nasıl tasarlanacak | En zor operasyonel kısım | açık |
| 6 | Prior art: bunu yapan var mı? | İddianın dayanağı | ✅ **kapandı** — bkz. bölüm 8; ürünleşmiş rakip yok |
| 7 | Secure element + attestation sertleştirmesi v1'e girsin mi | Saldırı bariyerini yükseltir, kapsamı da büyütür | açık |
| 8 | **Hackathon arşivleri taranmalı** (Colosseum dizini, Devpost) | Bölüm 8'in tek kör noktası | **yeni** |
| 9 | **Hacim rakamı Artemis'ten teyit edilmeli** — metrik adı + tarihle | Kaynaklar ayrışıyor; yanlış rakam kredibilite kaybı (bkz. 7) | **yeni** |
| 10 | Hibe ödeme birimi | — | ✅ **kapandı** — USDG (bkz. 10) |
| 11 | **Varsayılan yol hangisi olacak** — taze blockhash mi durable nonce mu? | 3.6 iki yolu da sunuyor ama SDK'nın varsayılanı bir ürün kararı. Satıcının bağlantı kalitesini nasıl ölçüp otomatik seçeceğimiz de buna bağlı | **yeni** |

---

## 13. Sözlük

| Terim | Anlamı |
|---|---|
| **Stablecoin / USDC** | Değeri bir para birimine sabitlenmiş kripto varlık; USDC = 1 ABD doları |
| **Solana Pay** | Solana'nın standart ödeme protokolü; QR/URL ile ödeme başlatır |
| **Slot** | Solana'da blok üretim aralığı; şu anda ~400ms, hedef 200ms |
| **Blockhash** | Yakın geçmişteki bir bloğun kimliği; her işlem taşımak zorunda, 150 slot sonra ölüyor |
| **Durable nonce** | Blockhash yerine zincirde saklanan, eskimeyen değer; işlemin son kullanma tarihini kaldırır |
| **Nonce authority** | Nonce hesabını ilerletme yetkisi olan taraf; bizde alıcı |
| **`AdvanceNonceAccount`** | Nonce'u ilerleten talimat; durable nonce işlemlerinde **ilk talimat** olmak zorunda |
| **Fee payer** | İşlem ücretini ödeyen imzacı; bizde satıcı |
| **ATA** (Associated Token Account) | Bir cüzdana ait, belirli bir token'ı tutan standart hesap |
| **`createAssociatedTokenAccountIdempotent`** | ATA yoksa oluşturan, varsa hata vermeyen talimat |
| **PDA** (Program Derived Address) | Bir programın kontrol ettiği, özel anahtarı olmayan hesap |
| **Rent (kira)** | Hesabın zincirde yer kaplaması için yatırılan depozito; hesap kapatılınca geri alınır |
| **ALT** (Address Lookup Table) | İşlemdeki hesap adreslerini kısaltarak boyut düşüren mekanizma |
| **base45** | QR'ın alphanumeric moduna uygun, base64'ten daha yoğun kodlama |
| **QR versiyonu / EC seviyesi** | QR'ın boyut ve hata düzeltme kademesi; yüksek versiyon = zor okuma |
| **Floor limit** | Kart ağlarında, altında çevrimdışı onay verilen tutar eşiği |
| **Equivocation slashing** | Aynı sıra numarasına iki çelişkili imza atıldığında teminatın kesilmesi (v2 alternatifinde) |
| **Light client (ışık istemci)** | Tüm zinciri indirmeden zincir durumunu doğrulayabilen istemci |
| **SDK** | Başkalarının üzerine uygulama inşa edebileceği geliştirici kütüphanesi |

---

## 14. Kaynaklar

**Problem tarafı**
- https://docs.solanapay.com/core/overview
- https://solana.com/docs/core/transactions/durable-nonces (deprecation uyarısı burada)

**Durable nonce**
- https://solana.com/developers/guides/advanced/introduction-to-durable-nonces
- https://docs.anza.xyz/implemented-proposals/durable-tx-nonces
- https://www.quicknode.com/guides/solana-development/transactions/how-to-send-offline-tx

**Halef format — bölüm 6.3'ün dayanağı**
- https://github.com/solana-foundation/solana-improvement-documents/discussions/415 (Nonce Payload Transaction — sarmalama önerisi)

**Kira ve ağ güncellemeleri**
- https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0437-incremental-rent-reduction.md (kabul edildi, %90 kira indirimi, beş kademe)
- https://solana.com/upgrades/reduced-slot-times (SIMD-0525, dört 50ms kademe)
- https://solanacompass.com/news/solana-cuts-slot-time-to-350ms-at-epoch-1020-first-reduction-since-network-launch (ilk kademe canlı: epoch 1020, 21 Ağu 2026)
- https://solana.com/upgrades/agave-4-2-release-overview
- https://www.helius.dev/blog/agave-v4-2
- https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0296-larger-transactions.md (v1 formatta 4.096 bayt)
- https://solana.com/news/solana-changelog-august-6-2026 (`ed25519-programmatic-signer` nonce implementasyonu)

**Prior art — bölüm 8**
- https://github.com/Coding-With-Josh/zypp (Solana'daki tek doğrudan benzer proje; 7 commit)
- https://github.com/helius-labs/durable-nonce · https://github.com/0xproflupin/solana-durable-nonces
- https://dfns.co/article/solana-durable-nonces-support · https://blog.fordefi.com/warping-time-for-solana-defi-reconciling-expiring-nonces-and-institutional-policy-controls (üretimde kullanım)
- https://www.crunchfish.com/crunchfish-digital-cash-security-webinar-solving-double-spending-offline/ · https://www.crunchfish.com/how-it-works/
- https://www.federalreserve.gov/econres/notes/feds-notes/offline-payments-implications-for-reliability-and-resiliency-in-digital-payment-systems-20240816.html
- https://arxiv.org/pdf/2408.06956 (PayOff) · https://eprint.iacr.org/2024/1746/ (CBDC + secure element)

**Piyasa**
- https://www.theblock.co/news/markets/2026-03-04-solana-stablecoin-volume-record-650-billion-february-onchain-payments-demand-grayscale-392217
- https://www.spark.money/research/solana-stablecoin-payment-ecosystem

**Hibe**
- https://superteam.fun/earn/grants/solana-foundation-turkey-grants
- https://solana.org/grants-funding

---

## 15. Özet — arkadaşlara tek nefeste

Solana'da ödeme yapmak için bugün internete bağlı olman şart, çünkü her işlem, ömrü bir dakikanın altına inmiş bir blockhash taşımak zorunda (21 Ağustos 2026'da 52,5 saniyeye düştü, hedef 30). Solana'nın 2020'den beri duran ama kimsenin ödeme için kullanmadığı **durable nonce** özelliği bu süreyi tamamen kaldırıyor. Biz de bunu kullanarak, alıcının telefonunun **ağa hiç dokunmadan** geçerli bir USDC ödemesi imzalamasını sağlıyoruz; ödeme iki QR kodla satıcının telefonuna geçiyor, satıcı imzayı çevrimdışı doğrulayıp kuyruğa alıyor ve interneti gelince gönderiyor. İşlem ücretini satıcı ödediği için alıcının hiç SOL'ü olması gerekmiyor — sadece USDC. Satıcının bağlantısı sağlamsa nonce'a hiç gerek kalmadan taze blockhash'le de çalışıyoruz; SDK iki yolu tek arayüz arkasında sunuyor. Çift harcamayı çözdüğümüzü iddia etmiyoruz; kart ağlarının kırk yıldır kullandığı **tutar tavanı** yaklaşımıyla sınırlandırıyoruz ve birincil senaryoyu "alıcı çevrimdışı, satıcı çevrimiçi" olarak kuruyoruz — bu modda risk pratikte sıfıra yaklaşıyor. Yeni bir zincir üstü program yazmadığımız için denetim gerekmiyor, hiçbir aşamada aracı, hakem veya ihraççı yok, ve iş 4-6 haftada bitiyor.
