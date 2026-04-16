// ============================================================
// services/phoneValidator.js — Groq LLM Telefon Validasyonu
// ============================================================
// Primary: Groq GPT-OSS 120B (hızlı, ucuz, JSON mode)
// Fallback: Basit regex (Groq down ise)
// ============================================================

const { config } = require('../config/env');
const log = require('../utils/logger');

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `Sen bir telefon numarası validatörüsün.
Kullanıcının girdiği metni analiz et ve SADECE aşağıdaki JSON formatında cevap ver:

{"valid": true, "normalized": "+905321234567", "reason": ""}
veya
{"valid": false, "normalized": null, "reason": "Kullanıcı numara vermek istemediğini belirtti"}

Kurallar:
- Türk GSM numaraları 5 ile başlar ve 10 hanedir (5XX XXX XX XX)
- Eğer numara 05 ile başlıyorsa, başındaki 0'ı kaldır ve +90 ekle
- Eğer numara 5 ile başlıyorsa ve 10 haneliyse, +90 ekle
- Eğer +90 veya 0090 ile başlıyorsa, +90 formatına normalize et
- Boşlukları, parantezleri, tireleri temizle
- Eğer metin bir telefon numarası DEĞİLSE (ör: "vermek istemiyorum", "yok", "bilmiyorum", rastgele harfler), valid: false döndür ve sebebini reason'a yaz
- Uluslararası numaralar (Türkiye dışı) da kabul et, + ile başlamalı
- SADECE JSON döndür, başka bir şey yazma`;

async function validatePhone(input) {
  // PRIMARY: Groq GPT-OSS 120B
  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: input }
        ],
        max_tokens: 200,
        temperature: 0,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      throw new Error(`Groq HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const result = JSON.parse(data.choices[0].message.content);
    log.info(`[phoneValidator] Groq sonuç: ${JSON.stringify(result)}`);
    return result;

  } catch (primaryError) {
    log.error(`[phoneValidator] Groq hatası, regex fallback: ${primaryError.message}`, primaryError.stack);
    return regexFallback(input);
  }
}

function regexFallback(input) {
  const digits = input.replace(/\D/g, '');

  if (/^905\d{8}$/.test(digits)) {
    return { valid: true, normalized: `+${digits}`, reason: "regex fallback" };
  }
  if (/^05\d{9}$/.test(digits)) {
    return { valid: true, normalized: `+9${digits}`, reason: "regex fallback" };
  }
  if (/^5\d{9}$/.test(digits)) {
    return { valid: true, normalized: `+90${digits}`, reason: "regex fallback" };
  }
  // Uluslararası format
  if (/^\d{10,15}$/.test(digits) && !digits.startsWith('90')) {
    return { valid: true, normalized: `+${digits}`, reason: "regex fallback - uluslararası" };
  }

  return { valid: false, normalized: null, reason: "Geçerli telefon numarası bulunamadı (regex fallback)" };
}

module.exports = { validatePhone };
