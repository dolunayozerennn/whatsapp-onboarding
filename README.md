# WhatsApp Onboarding — AI Factory

Skool'a kayıt olan yeni üyelere 7 gün boyunca WhatsApp üzerinden onboarding videoları gönderen otomasyon sistemi.

## Akış

```
Skool (yeni üye) → Zapier (2 webhook) → Railway (Express) → Notion CRM + ManyChat API → WhatsApp
```

## Altyapı

| Bileşen | Detay |
|---------|-------|
| **Runtime** | Node.js (Express) |
| **Hosting** | Railway (Worker — 7/24) |
| **Domain** | `whatsapp-onboarding-production.up.railway.app` |
| **GitHub** | `dolunayozerennn/whatsapp-onboarding` (private, standalone repo) |
| **Railway Project ID** | `5f346c33-6af1-4788-8405-34133c98451b` |
| **Service ID** | `64673112-d65a-4286-abc7-808af50901ce` |
| **Environment ID** | `f2000489-b711-4224-9fd4-44791bdb59d4` |

## Webhook Endpoints

| Endpoint | Tetikleyen | Açıklama |
|----------|-----------|----------|
| `POST /webhook/new-paid-member` | Zapier Zap #1 | Yeni ödeme yapan üyeyi Notion'a kaydeder |
| `POST /webhook/membership-questions` | Zapier Zap #2 | Telefon numarasını valide eder, WhatsApp onboarding başlatır |
| `GET /health` | Monitoring | Servis sağlık kontrolü |

## WhatsApp 24-Saat Window Stratejisi (Nisan 2026)

Tüm 7 onboarding mesajı (Gün 0'dan Gün 6'ya kadar) istisnasız **WhatsApp Template Message** olarak gönderilecek ve ManyChat üzerinde **"Send outside 24-hour window"** seçeneği ile yapılandırılacaktır.

**Neden bu strateji seçildi?**
- **İletim Garantisi:** Mesajlar her gün saat 11:00'da gönderilecektir. Kullanıcının kayıt saati (Gün 0) ne olursa olsun (örn: 12:00'da kayıt olduysa, ertesi gün 11:00'da 24 saat geçmemiş olur ancak 2. gün 11:00'da mutlaka geçmiş olur), template kullanımı sayesinde mesajlar asla engellenmez.
- **Kopmayan Akış:** Kullanıcı bir önceki günün mesajına tıklamasa dahi (window kapansa bile) sıradaki videoyu kesin olarak alır.
- **Maliyet Optimizasyonu:** Mümkünse Utility kategorisi tercih edilecek ve her mesaja buton (örn: "Sonraki videoyu al 🎬") eklenecektir. Her buton tıklaması 24 saatlik yeni bir ücretsiz mesajlaşma (Service/Utility) penceresi açar.

## 7 Günlük Onboarding İçeriği

| Gün | İçerik | Kanal | ManyChat Flow ID |
|-----|--------|-------|-----------------|
| 0 | Hoş geldin + Buradan Başla | Webhook anında gönderir | `content20260416192942_086852` ✅ |
| 1 | Tarayıcıya ekle + mobil app | Cron (12:00 İstanbul) | `content20260416193100_799326` ✅ |
| 2 | Başarı hikayeleri | Cron | `content20260421135407_534387` ✅ |
| 3 | Platform turu | Cron | `content20260421135530_976562` ✅ |
| 4 | Yıllık üyelik + JoinSecret | Cron | `content20260421135555_430815` ✅ |
| 5 | Takvim + etkinlikler | Cron | `content20260421160009_655436` ✅ |
| 6 | Affiliate programı + veda | Cron | `content20260421160043_896289` ✅ |

## Servisler

- **Notion CRM** — Üye veritabanı ve onboarding state yönetimi
  - DB ID: `0a84f19d-8dd4-4c08-9226-71d9ce71411f`
  - DB Adı: "Üye Onboarding Takip"
  - Token: `NOTION_SOCIAL_TOKEN` kullanılıyor (ana token değil!)
- **ManyChat API** — WhatsApp template mesaj gönderimi (sendFlow)
  - Custom fields: `onboarding_name` (14495722), `whatsapp_phone_text` (14495740)
- **Groq LLM** — Telefon numarası validasyonu (llama-4-scout + regex fallback)
- **Resend** — Email fallback (opsiyonel, henüz kurulu değil)

## Ortam Değişkenleri

| Variable | Açıklama | Railway'de Set? |
|----------|----------|----------------|
| `PORT` | Server port (3000) | ✅ |
| `NOTION_API_KEY` | Notion integration token | ✅ |
| `NOTION_DATABASE_ID` | Onboarding DB ID | ✅ |
| `MANYCHAT_API_TOKEN` | ManyChat WhatsApp API | ✅ |
| `GROQ_API_KEY` | Groq telefon validasyon | ✅ |
| `CRON_TIMEZONE` | Europe/Istanbul | ✅ |
| `CRON_SCHEDULE` | 0 12 * * * | ✅ |
| `RESEND_API_KEY` | Email fallback (opsiyonel) | ❌ Henüz yok |
| `RESEND_FROM_EMAIL` | Gönderici email | ❌ Henüz yok |

## Zapier Konfigürasyonu

### Zap #1: New Paid Member ✅ YAPILDI
- **Trigger:** Skool → "New Paid Member"
- **Action:** Webhooks by Zapier → POST
- **URL:** `https://whatsapp-onboarding-production.up.railway.app/webhook/new-paid-member`
- **Payload Type:** JSON
- **Data mapping:**
  - `transaction_id` → Skool `id`
  - `first_name` → Skool `first_name`
  - `last_name` → Skool `last_name`
  - `email` → Skool `email`
  - `date` → Skool `created_at`
- **Durum:** ✅ Konfigürasyon tamamlandı

### Zap #2: Membership Questions ⏳ DEVAM EDİYOR
- **Trigger:** Skool → "Answered Membership Questions"
- **Action:** Webhooks by Zapier → POST
- **URL:** `https://whatsapp-onboarding-production.up.railway.app/webhook/membership-questions`
- **Payload Type:** JSON
- **Data mapping:**
  - `transaction_id` → Skool `id`
  - `first_name` → Skool `first_name`
  - `last_name` → Skool `last_name`
  - `answer_1` → Skool'da telefon sorusuna verilen cevap
- **Durum:** ⏳ Webhook URL eklendi, data mapping henüz tamamlanmadı. Skool'da Membership Questions sorusu açıldıktan sonra field mapping yapılacak.

## Dosya Yapısı

```
WhatsApp_Onboarding/
├── server.js                  # Express server + webhook endpoints
├── cron.js                    # Günlük onboarding cron job (12:00 İstanbul)
├── services/
│   ├── notion.js              # Notion CRM CRUD işlemleri
│   ├── manychat.js            # ManyChat API (subscriber + sendFlow)
│   ├── phoneValidator.js      # Groq LLM destekli telefon validasyonu
│   └── resend.js              # Email fallback (Resend API — opsiyonel)
├── config/
│   ├── templates.js           # Template ve Flow ID eşleştirmeleri
│   └── env.js                 # Fail-fast environment validation
├── utils/
│   └── logger.js              # Yapılandırılmış loglama
├── package.json               # Pinned dependencies
├── .env                       # Lokal credentials (gitignored)
├── .env.example               # Örnek env dosyası
└── antigravity_whatsapp_onboarding_v2.md  # Planlama dokümanı (gitignored)
```

## Geliştirme

```bash
npm install
cp .env.example .env  # Değerleri doldur
npm run dev
```

## Deploy

Railway üzerinde worker olarak çalışır. GitHub push → auto-deploy.

---

## ✅ Çözülen Sorunlar

### Notion Integration — ÇÖZÜLDÜ (17 Nisan 2026)
- Planlama dokümanındaki DB ID (`dc72a04e...`) yanlıştı
- Gerçek DB ID: `0a84f19d-8dd4-4c08-9226-71d9ce71411f`
- Doğru token: `NOTION_SOCIAL_TOKEN` (ana token bu workspace'e erişemiyor)
- Railway env güncellendi ve redeploy yapıldı
- Health check: `status: "ok"` ✅

**Proje:** Antigravity Ekosistemi  
**Versiyon:** 1.0.0  
**İlk deploy:** 17 Nisan 2026  
**Son güncelleme:** 21 Nisan 2026
