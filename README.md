# WhatsApp Onboarding — AI Factory

Skool'a kayıt olan yeni üyelere 7 gün boyunca WhatsApp üzerinden onboarding videoları gönderen otomasyon sistemi.

## Akış

```
Skool (yeni üye) → Zapier (2 webhook) → Railway (Express) → Notion CRM + ManyChat API → WhatsApp
```

## Webhook Endpoints

| Endpoint | Tetikleyen | Açıklama |
|----------|-----------|----------|
| `POST /webhook/new-paid-member` | Zapier Zap #1 | Yeni ödeme yapan üyeyi Notion'a kaydeder |
| `POST /webhook/membership-questions` | Zapier Zap #2 | Telefon numarasını valide eder, WhatsApp onboarding başlatır |
| `GET /health` | Monitoring | Servis sağlık kontrolü |

## 7 Günlük Onboarding İçeriği

| Gün | İçerik | Kanal |
|-----|--------|-------|
| 0 | Hoş geldin + Buradan Başla | Webhook anında gönderir |
| 1 | Tarayıcıya ekle + mobil app | Cron (12:00 İstanbul) |
| 2 | Başarı hikayeleri | Cron |
| 3 | Platform turu | Cron |
| 4 | Yıllık üyelik + JoinSecret | Cron |
| 5 | Takvim + etkinlikler | Cron |
| 6 | Affiliate programı + veda | Cron |

## Servisler

- **Notion CRM** — Üye veritabanı ve onboarding state yönetimi
- **ManyChat API** — WhatsApp template mesaj gönderimi (sendFlow)
- **Groq LLM** — Telefon numarası validasyonu (AI destekli)
- **Resend** — Email fallback (telefon numarası geçersizse)

## Ortam Değişkenleri

`.env.example` dosyasına bak.

## Geliştirme

```bash
npm install
cp .env.example .env  # Değerleri doldur
npm run dev
```

## Deploy

Railway üzerinde worker olarak çalışır. GitHub push → auto-deploy.

---

**Proje:** Antigravity Ekosistemi  
**Versiyon:** 1.0.0  
**Son güncelleme:** Nisan 2026
