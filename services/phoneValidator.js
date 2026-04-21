// ============================================================
// services/phoneValidator.js — Groq LLM Telefon Validasyonu
// ============================================================
// Primary: Groq GPT-OSS 120B (hızlı, ucuz, JSON mode)
// Fallback: Basit regex (Groq down ise)
// ============================================================

const { config } = require('../config/env');
const log = require('../utils/logger');

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `Sen bir veri dönüştürme aracısın. Gelen metinden telefon numarasını çıkar ve SADECE JSON döndür.
JSON formatı:
{"valid": true, "normalized": "+905321234567", "reason": ""}
veya
{"valid": false, "normalized": null, "reason": "Numara yok"}

KURALLAR (KRİTİK):
1. Rakamların sırasını ASLA değiştirme. Girdiği gibi çıkar. Halüsinasyon yaparsan sistem çöker.
2. Sadece boşlukları ve tireleri temizle.
3. Numara '5' ile başlıyorsa ve toplam 10 rakamsa başa '+90' ekle.
4. Numara '05' ile başlıyorsa ve toplam 11 rakamsa başa '+9' ekle.
5. Kullanıcı sohbet veya itiraz ediyorsa valid: false döndür.`;

async function validatePhone(input) {
  // PRIMARY: Groq LLaMA 3.3 70B (Düşük halüsinasyon, net JSON formatı)
  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
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
