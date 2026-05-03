// ============================================================
// utils/phone.js — E.164 Normalizasyon Yardımcıları
// ============================================================
// Faz 3 P1 #16: Telefon read/write boundary'lerinde tek tip
// E.164 (`+90...`) formatı zorunlu. Bu helper; Notion, ManyChat,
// webhook handler'ları gibi tüm noktalarda kullanılmalı.
//
// libphonenumber-js varsayılan ülke = TR.
// ============================================================

const { parsePhoneNumberFromString } = require('libphonenumber-js');

/**
 * Verilen ham telefon girdisini E.164'e çevirir (TR varsayılan).
 * Geçersizse `null` döner. Asla throw etmez.
 *
 * @param {string|undefined|null} rawPhone
 * @param {string} defaultCountry - ISO-3166 ülke kodu (varsayılan: 'TR')
 * @returns {string|null} `+905...` formatı veya null
 */
function toE164(rawPhone, defaultCountry = 'TR') {
  if (!rawPhone) return null;
  const cleaned = String(rawPhone).trim();
  if (!cleaned) return null;

  // 1. Direkt parse: girdi zaten + ile başlıyorsa veya TR formatı tanınırsa
  let phone = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (phone && phone.isValid()) return phone.number;

  // 2. Sadece rakam çıkar, çeşitli prefix kombinasyonlarını dene
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (!digitsOnly) return null;

  const candidates = [
    `+${digitsOnly}`,                          // 905...   → +905...
    digitsOnly,                                // 0532... veya 5...  → TR default
    `+90${digitsOnly.replace(/^0/, '')}`       // 0532... → +90532...
  ];

  for (const candidate of candidates) {
    phone = parsePhoneNumberFromString(candidate, defaultCountry);
    if (phone && phone.isValid()) return phone.number;
  }

  return null;
}

/**
 * Logging için telefon numarasını maskeleyerek son 4 haneyi gösterir.
 * "+905381234567" → "***4567". KVKK uyumlu loglama için kullanılır.
 *
 * @param {string|undefined|null} phone
 * @returns {string}
 */
function maskPhone(phone) {
  if (!phone) return '***';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

module.exports = { toE164, maskPhone };
