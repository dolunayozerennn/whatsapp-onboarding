// ============================================================
// services/resend.js — Email Fallback (Resend API)
// ============================================================
// Telefon numarası geçersiz olan üyeler için email onboarding.
// Resend kurulu değilse sessizce atlanır (opsiyonel servis).
// ============================================================

const { config } = require('../config/env');
const log = require('../utils/logger');

// Fix: XSS koruması — kullanıcı adlarında <script> vb. engelleme
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
          <!-- WA_CTA_PLACEHOLDER -->
          <tr>
            <td style="padding:20px 24px 8px 24px; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:20px; font-weight:700; color:#111827;">
              Merhaba ${escapeHtml(firstName)} \u{1F44B}
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
          <tr>
            <td style="padding:12px 24px 20px 24px; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:11px; line-height:1.4; color:#9CA3AF; text-align:center;">
              Bu e-mail AI Factory toplulu\u011funa kaydoldu\u011fun i\u00e7in g\u00f6nderildi.
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

  // Cloudinary thumbnail'ler (mevcut — de\u011fi\u015fmedi)
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
      subject: `Merhaba ${escapeHtml(firstName)} - AI Factory'ye Ho\u015f Geldin`,
      body: `AI Factory toplulu\u011funa kat\u0131ld\u0131\u011f\u0131n i\u00e7in te\u015fekk\u00fcr ederim.
              <br>
              Senin i\u00e7in \u00e7ok k\u0131sa bir ho\u015f geldin videosu haz\u0131rlad\u0131m.
              <br><br>
              A\u015fa\u011f\u0131daki videoya t\u0131klayarak izleyebilirsin. \u{1F447}
              <br><br>
              \u00d6n\u00fcm\u00fcdeki 6 g\u00fcn boyunca her g\u00fcn sana b\u00f6yle k\u0131sa bir video g\u00f6nderece\u011fim,
              <br>
              e-posta kutunu ara ara kontrol etmeyi unutma. \u{1F680}`,
      footer: `AI Factory toplulu\u011funu incelemek istersen
              <a href="https://www.skool.com/yapay-zeka-factory" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya t\u0131klayabilirsin</a>.`
    },
    1: {
      subject: `G\u00fcn 1 \u2013 AI Factory`,
      body: `Bug\u00fcn serinin ilk devam videosunu g\u00f6nderdim.
              <br>
              Senin i\u00e7in yine \u00e7ok k\u0131sa bir kay\u0131t haz\u0131rlad\u0131m.
              <br><br>
              A\u015fa\u011f\u0131daki videoya t\u0131klayarak izleyebilirsin. \u{1F447}
              <br><br>
              Yar\u0131n bir e-mail daha gelecek, takipte kal. \u{1F440}`,
      footer: `AI Factory toplulu\u011funa ve Skool uygulamas\u0131na a\u015fa\u011f\u0131daki linklerden ula\u015fabilirsin:
              <br><br>
              Topluluk:
              <a href="https://www.skool.com/yapay-zeka-factory" target="_blank" style="color:#2563EB; text-decoration:underline;">AI Factory</a>
              <br>
              iOS uygulamas\u0131:
              <a href="https://apps.apple.com/us/app/skool-communities/id6447270545" target="_blank" style="color:#2563EB; text-decoration:underline;">App Store</a>
              <br>
              Android uygulamas\u0131:
              <a href="https://play.google.com/store/apps/details?id=com.skool.skoolcommunities&hl=en&gl=US" target="_blank" style="color:#2563EB; text-decoration:underline;">Google Play</a>`
    },
    2: {
      subject: `G\u00fcn 2 \u2013 AI Factory`,
      body: `Bug\u00fcn de serinin bir sonraki videosunu g\u00f6nderiyorum.
              <br>
              Her zamanki gibi k\u0131sa ve h\u0131zl\u0131 bir video haz\u0131rlad\u0131m.
              <br><br>
              A\u015fa\u011f\u0131daki videoya t\u0131klayarak izleyebilirsin. \u{1F447}
              <br><br>
              Yar\u0131n yeni bir e-mail daha alacaks\u0131n. \u{1F501}`,
      footer: `AI Factory'de Classroom b\u00f6l\u00fcm\u00fcn\u00fc a\u00e7mak istersen
              <a href="https://www.skool.com/yapay-zeka-factory/classroom" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya t\u0131klayabilirsin</a>.`
    },
    3: {
      subject: `G\u00fcn 3 \u2013 AI Factory`,
      body: `Serinin \u00fc\u00e7\u00fcnc\u00fc videosu haz\u0131r.
              <br>
              Yine birka\u00e7 dakikal\u0131k, h\u0131zl\u0131 t\u00fcketilen bir kay\u0131t.
              <br><br>
              A\u015fa\u011f\u0131daki videoya t\u0131klayarak izleyebilirsin. \u{1F447}
              <br><br>
              Yar\u0131n serinin bir sonraki ad\u0131m\u0131n\u0131 g\u00f6nderece\u011fim. \u{1F51C}`,
      footer: `Topluluk sayfas\u0131n\u0131 a\u00e7mak istersen
              <a href="https://www.skool.com/yapay-zeka-factory" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya t\u0131klayabilirsin</a>.`
    },
    4: {
      subject: `G\u00fcn 4 \u2013 AI Factory`,
      body: `Bug\u00fcn de senin i\u00e7in k\u0131sa bir video b\u0131rakt\u0131m.
              <br>
              Seri boyunca her g\u00fcn k\u00fc\u00e7\u00fck bir ad\u0131m daha at\u0131yoruz.
              <br><br>
              A\u015fa\u011f\u0131daki videoya t\u0131klayarak izleyebilirsin. \u{1F447}
              <br><br>
              Yar\u0131n gelen e-mail'i de ka\u00e7\u0131rma. \u{1F4B8}`,
      footer: `Affiliate davet linkini almak i\u00e7in AI Factory'yi a\u00e7mak istersen
              <a href="https://www.skool.com/yapay-zeka-factory" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya t\u0131klayabilirsin</a>.
              <br><br>
              \u0130ndirim platformu:
              <a href="https://ai-factory.joinsecret.com/" target="_blank" style="color:#2563EB; text-decoration:underline;">Joinsecret</a>`
    },
    5: {
      subject: `G\u00fcn 5 \u2013 AI Factory`,
      body: `Serinin be\u015finci videosu e-posta kutuna indi.
              <br>
              Her zamanki gibi k\u0131sa tutulmu\u015f bir kay\u0131t.
              <br><br>
              A\u015fa\u011f\u0131daki videoya t\u0131klayarak izleyebilirsin. \u{1F447}
              <br><br>
              Yar\u0131n son videoyu g\u00f6nderece\u011fim. \u2699\uFE0F`,
      footer: `Classroom'daki otomasyonlar\u0131 incelemek istersen
              <a href="https://www.skool.com/yapay-zeka-factory/classroom" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya t\u0131klayabilirsin</a>.`
    },
    6: {
      subject: `G\u00fcn 6 \u2013 AI Factory`,
      body: `Bu, serinin alt\u0131nc\u0131 ve son videosu.
              <br>
              Her \u015fey yine h\u0131zl\u0131 ve k\u0131sa bir kay\u0131t halinde.
              <br><br>
              A\u015fa\u011f\u0131daki videoya t\u0131klayarak izleyebilirsin. \u{1F447}
              <br><br>
              AI Factory'de seni daha uzun s\u00fcre g\u00f6rmek i\u00e7in sab\u0131rs\u0131zlan\u0131yorum. \u{1F91D}`,
      footer: `Y\u0131ll\u0131k \u00fczelik planlar\u0131n\u0131 ve indirim platformunu a\u015fa\u011f\u0131daki linklerden g\u00f6rebilirsin:
              <br><br>
              Y\u0131ll\u0131k \u00fcyelik:
              <a href="https://www.skool.com/yapay-zeka-factory/plans" target="_blank" style="color:#2563EB; text-decoration:underline;">AI Factory Planlar</a>
              <br>
              \u0130ndirim platformu:
              <a href="https://ai-factory.joinsecret.com/" target="_blank" style="color:#2563EB; text-decoration:underline;">Joinsecret</a>
              <br><br>
              Canl\u0131 yay\u0131n takvimini g\u00f6rmek ve etkinlikleri takvimine eklemek i\u00e7in
              <a href="https://www.skool.com/yapay-zeka-factory/calendar" target="_blank" style="color:#2563EB; text-decoration:underline;">buraya t\u0131klayabilirsin</a>.`
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
// WhatsApp teslim ba\u015far\u0131s\u0131z oldu\u011funda g\u00f6nderilen email.
// waBusinessPhone doluysa \u2192 WA CTA blo\u011fu eklenir.
// waBusinessPhone bo\u015fsa \u2192 normal email g\u00f6nderilir (graceful degradation).
// ============================================================

// Fix: Dinamik WA CTA \u2014 telefon numaras\u0131 config'den al\u0131n\u0131r
function buildWaCta(waBusinessPhone) {
  return `<tr>
  <td style="padding:0 24px 16px 24px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f0fdf4; border-radius:8px; overflow:hidden;">
      <tr>
        <td style="padding:16px 20px 8px 20px; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:14px; line-height:1.6; color:#166534;">
          Bu mesajlar\u0131 WhatsApp'tan almak istersen a\u015fa\u011f\u0131daki butona dokun.
          <br>
          Bir \u015fey yapmazsan, e-posta'dan almaya devam edeceksin.
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:8px 20px 16px 20px;">
          <a href="https://wa.me/${waBusinessPhone}?text=Selam!%20AI%20Factory%20videolar%C4%B1m%C4%B1%20buradan%20almak%20istiyorum"
             target="_blank"
             style="display:inline-block; background-color:#25D366; color:#ffffff; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:15px; font-weight:600; padding:12px 28px; border-radius:8px; text-decoration:none;">
            WhatsApp'tan Al
          </a>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

async function sendHybridFallbackEmail(toEmail, firstName, dayNumber, waBusinessPhone) {
  if (!config.resendApiKey) {
    log.warn(`[resend] API key yok \u2014 hibrit email g\u00f6nderilmedi: ${toEmail} (G\u00fcn ${dayNumber})`);
    return null;
  }

  // O g\u00fcn\u00fcn email i\u00e7eri\u011fini al
  const emailContent = getEmailContent(firstName, dayNumber);
  let html = emailContent.html;

  // Subject: orijinalin \u00f6n\u00fcne fallback prefix ekle
  let subject = `Sana WhatsApp'tan ula\u015famad\u0131k \u2013 ${emailContent.subject}`;

  // waBusinessPhone doluysa \u2192 WA CTA blo\u011funu enjekte et
  if (waBusinessPhone) {
    html = html.replace('<!-- WA_CTA_PLACEHOLDER -->', buildWaCta(waBusinessPhone));
    log.info(`[resend] Hibrit fallback: WA CTA enjekte edildi (${waBusinessPhone})`);
  } else {
    // waBusinessPhone bo\u015fsa \u2192 CTA ekleme, normal email g\u00f6nder (graceful degradation)
    html = html.replace('<!-- WA_CTA_PLACEHOLDER -->', '');
    subject = emailContent.subject; // prefix de ekleme
    log.info(`[resend] Hibrit fallback: WA telefon yok, normal email g\u00f6nderiliyor`);
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
    log.info(`[resend] Hibrit fallback email g\u00f6nderildi: ${toEmail} \u2014 G\u00fcn ${dayNumber} (${data.id})`);
    return data;

  } catch (error) {
    log.error(`[resend] Hibrit fallback email hatas\u0131: ${error.message}`, error.stack);
    throw error;
  }
}

module.exports = { sendOnboardingEmail, sendHybridFallbackEmail, getEmailContent };
