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

// ============================================================
// Rich HTML Email Template Builder
// ============================================================
// Eski n8n workflow'dan birebir alınan HTML yapısı:
// - Beyaz kart (600px max-width, 12px border-radius, #f3f3f3 bg)
// - system-ui font ailesi
// - Tıklanabilir Cloudinary thumbnail → YouTube Short
// - Footer linkleri (güne göre değişen)
// - Disclaimer footer
// - <!-- WA_CTA_PLACEHOLDER --> (hibrit fallback için)
// ============================================================

function buildEmailHtml(firstName, bodyText, videoUrl, thumbnailUrl, footerHtml) {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <title>AI Factory</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f3f3f3;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f3f3f3;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:600px; background-color:#ffffff; border-radius:12px; overflow:hidden;">
          <tr>
            <td style="padding:20px 24px 8px 24px; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:20px; font-weight:700; color:#111827;">
              Merhaba ${firstName} 👋
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 16px 24px; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:15px; line-height:1.7; color:#111827;">
              ${bodyText}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 24px 12px 24px;">
              <a href="${videoUrl}" target="_blank" style="text-decoration:none; border:0; display:inline-block;">
                <img src="${thumbnailUrl}"
                     alt="Videoyu izle"
                     style="display:block; width:100%; max-width:552px; height:auto; border-radius:12px; border:0; outline:none; text-decoration:none;">
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 20px 24px; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:13px; line-height:1.6; color:#374151;">
              ${footerHtml}
            </td>
          </tr>
          <!-- WA_CTA_PLACEHOLDER -->
          <tr>
            <td style="padding:12px 24px 20px 24px; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:11px; line-height:1.4; color:#9CA3AF; text-align:center;">
              Bu e-mail AI Factory topluluğuna kaydolduğun için gönderildi.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function getEmailContent(firstName, dayNumber) {
  // Yeni YouTube Short linkleri
  const VIDEOS = {
    0: 'https://youtube.com/shorts/9FSegQUVrx4',
    1: 'https://youtube.com/shorts/5oS08SfS3O8',
    2: 'https://youtube.com/shorts/eSAka7X0cQU',
    3: 'https://youtube.com/shorts/ozKOWDND5Sw',
    4: 'https://youtube.com/shorts/6A7GF394128',
    5: 'https://youtube.com/shorts/QVuID3KiCEY',
    6: 'https://youtube.com/shorts/1s6eXhcoGNc'
  };

  // Cloudinary thumbnail'ler (mevcut — değişmedi)
  const THUMBNAILS = {
    0: 'https://res.cloudinary.com/ddh9eoasc/image/upload/v1764868964/0_vvfsif.png',
    1: 'https://res.cloudinary.com/ddh9eoasc/image/upload/v1764868962/1_icpitv.png',
    2: 'https://res.cloudinary.com/ddh9eoasc/image/upload/v1764868962/2_fahto7.png',
    3: 'https://res.cloudinary.com/ddh9eoasc/image/upload/v1764868962/3_tawckb.png',
    4: 'https://res.cloudinary.com/ddh9eoasc/image/upload/v1764868962/4_ujaqr9.png',
    5: 'https://res.cloudinary.com/ddh9eoasc/image/upload/v1764868963/5_pn9syd.png',
    6: 'https://res.cloudinary.com/ddh9eoasc/image/upload/v1764868963/6_tsygfh.png'
  };

  const contents = {
    0: {
      subject: `Merhaba ${firstName} - AI Factory'ye Hoş Geldin`,
      body: `AI Factory topluluğuna katıldığın için teşekkür ederim.
              <br>
              Senin için çok kısa bir hoş geldin videosu hazırladım.
              <br><br>
              Aşağıdaki videoya tıklayarak izleyebilirsin. 👇
              <br><br>
              Önümüzdeki 6 gün boyunca her gün sana böyle kısa bir video göndereceğim,
              <br>
              e-posta kutunu ara ara kontrol etmeyi unutma. 🚀`,
      footer: `AI Factory topluluğunu incelemek istersen
              <a href="https://www.skool.com/yapay-zeka-factory" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya tıklayabilirsin</a>.`
    },
    1: {
      subject: `Gün 1 – AI Factory`,
      body: `Bugün serinin ilk devam videosunu gönderdim.
              <br>
              Senin için yine çok kısa bir kayıt hazırladım.
              <br><br>
              Aşağıdaki videoya tıklayarak izleyebilirsin. 👇
              <br><br>
              Yarın bir e-mail daha gelecek, takipte kal. 👀`,
      footer: `AI Factory topluluğuna ve Skool uygulamasına aşağıdaki linklerden ulaşabilirsin:
              <br><br>
              Topluluk:
              <a href="https://www.skool.com/yapay-zeka-factory" target="_blank" style="color:#2563EB; text-decoration:underline;">AI Factory</a>
              <br>
              iOS uygulaması:
              <a href="https://apps.apple.com/us/app/skool-communities/id6447270545" target="_blank" style="color:#2563EB; text-decoration:underline;">App Store</a>
              <br>
              Android uygulaması:
              <a href="https://play.google.com/store/apps/details?id=com.skool.skoolcommunities&hl=en&gl=US" target="_blank" style="color:#2563EB; text-decoration:underline;">Google Play</a>`
    },
    2: {
      subject: `Gün 2 – AI Factory`,
      body: `Bugün de serinin bir sonraki videosunu gönderiyorum.
              <br>
              Her zamanki gibi kısa ve hızlı bir video hazırladım.
              <br><br>
              Aşağıdaki videoya tıklayarak izleyebilirsin. 👇
              <br><br>
              Yarın yeni bir e-mail daha alacaksın. 🔁`,
      footer: `AI Factory'de Classroom bölümünü açmak istersen
              <a href="https://www.skool.com/yapay-zeka-factory/classroom" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya tıklayabilirsin</a>.`
    },
    3: {
      subject: `Gün 3 – AI Factory`,
      body: `Serinin üçüncü videosu hazır.
              <br>
              Yine birkaç dakalık, hızlı tüketilen bir kayıt.
              <br><br>
              Aşağıdaki videoya tıklayarak izleyebilirsin. 👇
              <br><br>
              Yarın serinin bir sonraki adımını göndereceğim. 🔜`,
      footer: `Topluluk sayfasını açmak istersen
              <a href="https://www.skool.com/yapay-zeka-factory" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya tıklayabilirsin</a>.`
    },
    4: {
      subject: `Gün 4 – AI Factory`,
      body: `Bugün de senin için kısa bir video bıraktım.
              <br>
              Seri boyunca her gün küçük bir adım daha atıyoruz.
              <br><br>
              Aşağıdaki videoya tıklayarak izleyebilirsin. 👇
              <br><br>
              Yarın gelen e-mail'i de kaçırma. 💸`,
      footer: `Affiliate davet linkini almak için AI Factory'yi açmak istersen
              <a href="https://www.skool.com/yapay-zeka-factory" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya tıklayabilirsin</a>.
              <br><br>
              İndirim platformu:
              <a href="https://ai-factory.joinsecret.com/" target="_blank" style="color:#2563EB; text-decoration:underline;">Joinsecret</a>`
    },
    5: {
      subject: `Gün 5 – AI Factory`,
      body: `Serinin beşinci videosu e-posta kutuna indi.
              <br>
              Her zamanki gibi kısa tutulmuş bir kayıt.
              <br><br>
              Aşağıdaki videoya tıklayarak izleyebilirsin. 👇
              <br><br>
              Yarın son videoyu göndereceğim. ⚙️`,
      footer: `Classroom'daki otomasyonları incelemek istersen
              <a href="https://www.skool.com/yapay-zeka-factory/classroom" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya tıklayabilirsin</a>.`
    },
    6: {
      subject: `Gün 6 – AI Factory`,
      body: `Bu, serinin altıncı ve son videosu.
              <br>
              Her şey yine hızlı ve kısa bir kayıt halinde.
              <br><br>
              Aşağıdaki videoya tıklayarak izleyebilirsin. 👇
              <br><br>
              AI Factory'de seni daha uzun süre görmek için sabırsızlanıyorum. 🤝`,
      footer: `Yıllık üyelik planlarını ve indirim platformunu aşağıdaki linklerden görebilirsin:
              <br><br>
              Yıllık üyelik:
              <a href="https://www.skool.com/yapay-zeka-factory/plans" target="_blank" style="color:#2563EB; text-decoration:underline;">AI Factory Planlar</a>
              <br>
              İndirim platformu:
              <a href="https://ai-factory.joinsecret.com/" target="_blank" style="color:#2563EB; text-decoration:underline;">Joinsecret</a>
              <br><br>
              Canlı yayın takvimini görmek ve etkinlikleri takvimine eklemek için
              <a href="https://www.skool.com/yapay-zeka-factory/calendar" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya tıklayabilirsin</a>.`
    }
  };

  const day = contents[dayNumber] || contents[0];
  const safeDay = dayNumber in VIDEOS ? dayNumber : 0;

  return {
    subject: day.subject,
    html: buildEmailHtml(firstName, day.body, VIDEOS[safeDay], THUMBNAILS[safeDay], day.footer)
  };
}

// ============================================================
// Hibrit Fallback Email (WhatsApp CTA enjeksiyonlu)
// ============================================================
// WhatsApp teslim başarısız olduğunda gönderilen email.
// waBusinessPhone doluysa → WA CTA bloğu eklenir.
// waBusinessPhone boşsa → normal email gönderilir (graceful degradation).
// ============================================================

const WA_CTA_HTML = `<tr>
  <td style="padding:0 24px 16px 24px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f0fdf4; border-radius:8px; overflow:hidden;">
      <tr>
        <td style="padding:16px 20px 8px 20px; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:14px; line-height:1.6; color:#166534;">
          Bu mesajları WhatsApp'tan almak istersen aşağıdaki butona dokun.
          <br>
          Bir şey yapmazsan, e-posta'dan almaya devam edeceksin.
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:8px 20px 16px 20px;">
          <a href="https://wa.me/905374799287?text=Selam!%20AI%20Factory%20videolar%C4%B1m%C4%B1%20buradan%20almak%20istiyorum%20%F0%9F%93%B2"
             target="_blank"
             style="display:inline-block; background-color:#25D366; color:#ffffff; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:15px; font-weight:600; padding:12px 28px; border-radius:8px; text-decoration:none;">
            WhatsApp'tan Al
          </a>
        </td>
      </tr>
    </table>
  </td>
</tr>`;

async function sendHybridFallbackEmail(toEmail, firstName, dayNumber, waBusinessPhone) {
  if (!config.resendApiKey) {
    log.warn(`[resend] API key yok — hibrit email gönderilmedi: ${toEmail} (Gün ${dayNumber})`);
    return null;
  }

  // O günün email içeriğini al
  const emailContent = getEmailContent(firstName, dayNumber);
  let html = emailContent.html;

  // Subject: orijinalin önüne fallback prefix ekle
  let subject = `Sana WhatsApp'tan ulaşamadık – ${emailContent.subject}`;

  // waBusinessPhone doluysa → WA CTA bloğunu enjekte et
  if (waBusinessPhone) {
    html = html.replace('<!-- WA_CTA_PLACEHOLDER -->', WA_CTA_HTML);
    log.info(`[resend] Hibrit fallback: WA CTA enjekte edildi (${waBusinessPhone})`);
  } else {
    // waBusinessPhone boşsa → CTA ekleme, normal email gönder (graceful degradation)
    html = html.replace('<!-- WA_CTA_PLACEHOLDER -->', '');
    subject = emailContent.subject; // prefix de ekleme
    log.info(`[resend] Hibrit fallback: WA telefon yok, normal email gönderiliyor`);
  }

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
        subject: subject,
        html: html
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend HTTP ${response.status}: ${error}`);
    }

    const data = await response.json();
    log.info(`[resend] Hibrit fallback email gönderildi: ${toEmail} — Gün ${dayNumber} (${data.id})`);
    return data;

  } catch (error) {
    log.error(`[resend] Hibrit fallback email hatası: ${error.message}`, error.stack);
    throw error;
  }
}

module.exports = { sendOnboardingEmail, sendHybridFallbackEmail, getEmailContent };
