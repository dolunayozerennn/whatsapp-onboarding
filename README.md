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

## Webhook Endpoints

| Endpoint | Tetikleyen | Açıklama |
|----------|-----------|----------|
| `POST /webhook/new-paid-member` | Zapier Zap #1 | Yeni ödeme yapan üyeyi Notion'a kaydeder |
| `POST /webhook/membership-questions` | Zapier Zap #2 | Telefon numarasını valide eder, WhatsApp onboarding başlatır |
| `POST /webhook/wa-failed` | ManyChat | WhatsApp gönderim başarısız olduğunda email fallback tetikler |
| `GET /health` | Monitoring | Servis sağlık kontrolü |

## Servisler

- **Notion CRM** — Üye veritabanı ve onboarding state yönetimi
- **ManyChat API** — WhatsApp template mesaj gönderimi (sendFlow)
- **Groq LLM** — Telefon numarası validasyonu (llama-3.3-70b)
- **Resend** — Email fallback (opsiyonel)

## Geliştirme

```bash
npm install
cp .env.example .env  # Değerleri doldur
npm run dev
```

## Deploy

Railway üzerinde worker olarak çalışır. GitHub push → auto-deploy.

**Proje:** Antigravity Ekosistemi
**Versiyon:** 1.0.0
**Son güncelleme:** 23 Nisan 2026
