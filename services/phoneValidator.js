// ============================================================
// services/phoneValidator.js — Groq LLM ile Telefon Validasyonu
// ============================================================
// Kullanıcının verdiği serbest metin cevabından
// WhatsApp uyumlu E.164 telefon numarası çıkarır.
// ============================================================

const { config } = require('../config/env');
const log = require('../utils/logger');

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const SYSTEM_PROMPT = `Sen bir telefon numarası validatörüsün. Kullanıcının girdiği metinden telefon numarasını çıkar.

Kurallar:
1. E.164 formatına dönüştür (+ ile başlasın)
2. Türkiye numaraları +90 ile başlasın (10 haneli olmalı)
3. Diğer ülke kodlarını da tanı
4. Telefon numarası değilse valid: false dön

YANIT FORMAT (SADECE JSON):
{"valid": true/false, "normalized": "+905551234567", "confidence": 0.95, "reason": "..."}`;

async function validatePhone(rawInput) {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Kullanıcı girdişi: "${rawInput}"` }
        ],
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API hatası ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const result = JSON.parse(data.choices[0].message.content);

    log.info(`[phoneValidator] Girdi: "${rawInput}" → Sonuç: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    log.error(`[phoneValidator] Validasyon hatası: ${error.message}`, error);
    return {
      valid: false,
      normalized: null,
      confidence: 0,
      reason: `Validasyon hatası: ${error.message}`
    };
  }
}

module.exports = { validatePhone };
