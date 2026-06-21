// ============================================================
// services/wa_error.js — WhatsApp/dış-servis hata sınıflandırması (SAF)
// ============================================================
// Yan-etkisiz, ağ-yok, log-yok. cron.js bu kararları uygular; testler
// bağımsızca doğrular. (Çıktı Nöbeti doktrini: davranışı belirleyen
// mantık saf + test edilebilir olmalı; düzeltmeyi yapan elin testi de
// bu modüle karşı yazılır.)
// ============================================================

// Kalıcı hata sınıflandırması: bunlar 3-strike beklenmeden doğrudan DLQ'ya gider.
// Geçici hata (429, 5xx, timeout, network) ise error-counter mantığında kalır.
//   - ManyChat tipli WA_ID_INVALID / WA_UNREACHABLE: numarada WhatsApp yok / Meta engeli.
//   - WhatsApp 131xxx serisi: invalid recipient, blocked, opted-out, vb.
//   - 4xx (429 hariç) ve "invalid recipient/email/phone" kalıpları.
function isPermanentError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  const status = err.status || err.statusCode;
  // Geçici hatalar — kalıcı DEĞİL
  if (status === 429 || (status >= 500 && status < 600)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  if (/timeout|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg)) return false;
  // ManyChat tipli kalıcı kodlar — retry beyhude.
  if (err.code === 'WA_ID_INVALID' || err.code === 'WA_UNREACHABLE') return true;
  // Kalıcı sayılan kalıplar
  if (status >= 400 && status < 500) return true;
  if (/HTTP 4\d\d/.test(msg)) return true;
  // WhatsApp Cloud 131xxx kodları — hem parantezli (#131xx) hem ManyChat'in
  // JSON.stringify'lı gövdesindeki "code":131xx / code:131xx biçimini yakala.
  if (/\(#13\d{4}\)/.test(msg)) return true;
  if (/["']?code["']?\s*:\s*13\d{4}\b/.test(msg)) return true;
  if (/invalid (recipient|email|phone)/i.test(msg)) return true;
  if (/recipient.*not.*valid/i.test(msg)) return true;
  if (/blocked|opted.?out|unsubscribed/i.test(msg)) return true;
  return false;
}

// Dual üyede WhatsApp başarısız ama EMAIL gönderildiyse: onboarding'i dondurmak
// yerine email-only akışına düşürülmeli mi? Koşul: WA hatası KALICI olmalı (geçici
// WA hatası retry edilmeli, demote EDİLMEMELİ), email hatasız gitmiş olmalı.
// Bu, "Bayram donması"nın (2026-06-21 denetim) saf karar çekirdeğidir.
function shouldDemoteDualToEmail(waErr, emailErr, emailSentOk) {
  if (!waErr) return false;        // WA başarılı → demote yok
  if (emailErr) return false;      // email de patladı → ayrı (both-fail) yol
  if (!emailSentOk) return false;  // email gönderilmedi → demote dayanağı yok
  return isPermanentError(waErr);  // sadece KALICI WA hatasında email-only'ye düş
}

module.exports = { isPermanentError, shouldDemoteDualToEmail };
