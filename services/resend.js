// ============================================================
// services/resend.js — Email Fallback (Resend API)
// ============================================================
// WhatsApp onboarding başarısız olduğunda email gönderir.
// config.resendApiKey yoksa sessizce atlanır.
// ============================================================

const { config } = require('../config/env');
const log = require('../utils/logger');

async function sendOnboardingEmail(toEmail, firstName, dayIndex) {
  if (!config.resendApiKey) {
    log.warn('[resend] API key yok, email atlanıyor');
    return null;
  }

  const subjects = {
    0: `${firstName}, AI Factory'ye hoş geldin! 🚀`,
    1: 'Gün 1: Başlamak için ilk adımını at!',
    2: 'Gün 2: Başarı hikayeleri',
    3: 'Gün 3: Platformu keşfet',
    4: 'Gün 4: Yıllık üyelik fırsatı',
    5: 'Gün 5: Etkinlik takvimi',
    6: 'Gün 6: Affiliate programı'
  };

  const subject = subjects[dayIndex] || `AI Factory Onboarding — Gün ${dayIndex}`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: config.resendFromEmail,
        to: [toEmail],
        subject: subject,
        html: `<p>Merhaba ${firstName},</p><p>AI Factory onboarding içeriğin hazır. 🎉</p><p>Detaylar için topluluğumuza göz at: <a href="https://skool.com/ai-factory">AI Factory</a></p>`
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend API hatası ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    log.info(`[resend] Email gönderildi: ${toEmail} (Gün ${dayIndex}) — ID: ${data.id}`);
    return data;
  } catch (error) {
    log.error(`[resend] Email gönderme hatası: ${error.message}`, error);
    throw error;
  }
}

module.exports = { sendOnboardingEmail };
