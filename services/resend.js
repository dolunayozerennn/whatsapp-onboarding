// ============================================================
// services/resend.js — Email Fallback (Resend API)
// ============================================================
// Telefon numarası geçersiz olan üyeler için email onboarding.
// Resend kurulu değilse sessizce atlanır (opsiyonel servis).
// ============================================================

const { config } = require('../config/env');
const log = require('../utils/logger');

async function sendOnboardingEmail(toEmail, firstName, dayNumber) {
  if (!config.resendApiKey) {
    log.warn(`[resend] API key yok — email gönderilmedi: ${toEmail} (Gün ${dayNumber})`);
    return null;
  }

  const emailContent = getEmailContent(firstName, dayNumber);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `AI Factory <${config.resendFromEmail}>`,
        to: [toEmail],
        subject: emailContent.subject,
        html: emailContent.html
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend HTTP ${response.status}: ${error}`);
    }

    const data = await response.json();
    log.info(`[resend] Email gönderildi: ${toEmail} — Gün ${dayNumber} (${data.id})`);
    return data;

  } catch (error) {
    log.error(`[resend] Email hatası: ${error.message}`, error.stack);
    throw error;
  }
}

function getEmailContent(firstName, dayNumber) {
  const SKOOL_URL = "https://skool.com/yapay-zeka-factory/classroom";

  const contents = {
    0: {
      subject: "AI Factory'ye hoş geldin! 🚀",
      html: `<p>Merhaba ${firstName},</p><p>AI Factory topluluğuna hoş geldin! İlk tanıtım videomuzu izlemek için <a href="${SKOOL_URL}">buraya tıkla</a>.</p><p>Bundan sonra 7 gün boyunca sana kısa videolarla topluluğu tanıtacağım.</p>`
    },
    1: {
      subject: "Adım 1: Topluluğu favorilere ekle",
      html: `<p>Selam ${firstName},</p><p>Bugünkü videon hazır! <a href="${SKOOL_URL}">Buradan izle</a>.</p><p>Tarayıcına ekle ve mobil uygulamayı indir — böylece hiçbir şeyi kaçırmazsın.</p>`
    },
    2: {
      subject: "Üyelerimiz neler başardı?",
      html: `<p>Selam ${firstName},</p><p>Bugün sana topluluğumuzdaki gerçek başarı hikayelerini göstereceğim. <a href="${SKOOL_URL}">Videoyu izle</a>.</p>`
    },
    3: {
      subject: "Platform turu: Her şey burada",
      html: `<p>Selam ${firstName},</p><p>Bugünkü videoda platformun tüm bölümlerini keşfedeceksin. <a href="${SKOOL_URL}">Buradan izle</a>.</p>`
    },
    4: {
      subject: "Yıllık üyeliğin avantajları",
      html: `<p>Selam ${firstName},</p><p>Bugün seninle yıllık üyelik ve JoinSecret'i paylaşıyorum. <a href="${SKOOL_URL}">Detaylar videoda</a>.</p>`
    },
    5: {
      subject: "Canlı yayınlar ve etkinlikler",
      html: `<p>Selam ${firstName},</p><p>Takvimimizdeki etkinlikleri keşfet! <a href="${SKOOL_URL}">Videoyu izle</a>.</p>`
    },
    6: {
      subject: "Davet et ve kazan! 🎉",
      html: `<p>Selam ${firstName},</p><p>Son videomuz! Affiliate programımızla arkadaşlarını davet ederek kazanabilirsin. <a href="${SKOOL_URL}">Nasıl yapacağını öğren</a>.</p><p>Bundan sonra toplulukta, canlı yayınlarda ve eğitimlerde görüşürüz. Başarılar!</p>`
    }
  };

  return contents[dayNumber] || contents[0];
}

module.exports = { sendOnboardingEmail, getEmailContent };
