// ============================================================
// services/manychat.js — ManyChat WhatsApp API
// ============================================================
// KRİTİK: WhatsApp business-initiated mesaj için sendFlow kullanılır.
// sendContent KULLANILMAZ — template mesajlar flow içinde tetiklenir.
// ============================================================

const { config } = require('../config/env');
const log = require('../utils/logger');

const API_URL = "https://api.manychat.com/fb";
const headers = {
  'Authorization': `Bearer ${config.manychatApiToken}`,
  'Content-Type': 'application/json'
};

/**
 * Ana fonksiyon: subscriber yoksa oluştur, custom field'ları set et, flow'u tetikle
 */
async function ensureSubscriberAndSendFlow(phoneNumber, firstName, flowId) {
  let subscriberId;

  // 1. Subscriber'ı bulmaya çalış (custom field üzerinden)
  subscriberId = await findSubscriberByPhone(phoneNumber);

  if (!subscriberId) {
    // 2. Yoksa oluştur
    subscriberId = await createSubscriber(phoneNumber, firstName);
  }

  if (!subscriberId) {
    throw new Error(`Subscriber oluşturulamadı: ${phoneNumber}`);
  }

  // 3. Custom field'ları güncelle (template değişkenleri için)
  await setCustomFields(subscriberId, {
    onboarding_name: firstName,
    whatsapp_phone_text: phoneNumber
  });

  // 4. Flow'u tetikle (template mesajı bu flow'un içinde)
  await sendFlow(subscriberId, flowId);

  log.info(`[manychat] Flow gönderildi: ${firstName} (${phoneNumber}) → ${flowId}`);
  return subscriberId;
}

async function createSubscriber(phoneNumber, firstName) {
  try {
    const response = await fetch(`${API_URL}/subscriber/createSubscriber`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        first_name: firstName,
        whatsapp_phone: phoneNumber,
        consent_phrase: "onboarding"
      })
    });

    const data = await response.json();

    if (data.status === 'success') {
      log.info(`[manychat] Subscriber oluşturuldu: ${phoneNumber}`);
      return data.data.id;
    }

    // Subscriber zaten varsa hata döner — normal, findByCustomField ile bul
    log.info(`[manychat] createSubscriber: ${data.message || 'zaten var'}`);
    return await findSubscriberByPhone(phoneNumber);

  } catch (error) {
    log.error(`[manychat] createSubscriber hatası: ${error.message}`, error.stack);
    throw error;
  }
}

async function findSubscriberByPhone(phoneNumber) {
  try {
    const response = await fetch(`${API_URL}/subscriber/findByCustomField`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        field_name: "whatsapp_phone_text",
        field_value: phoneNumber
      })
    });

    const data = await response.json();

    if (data.status === 'success' && data.data) {
      return data.data.id;
    }

    return null;
  } catch (error) {
    log.error(`[manychat] findByCustomField hatası: ${error.message}`, error.stack);
    return null;
  }
}

async function setCustomFields(subscriberId, fields) {
  const fieldArray = Object.entries(fields).map(([name, value]) => ({
    field_name: name,
    field_value: String(value)
  }));

  const response = await fetch(`${API_URL}/subscriber/setCustomFields`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      subscriber_id: subscriberId,
      fields: fieldArray
    })
  });

  const data = await response.json();
  if (data.status !== 'success') {
    log.warn(`[manychat] setCustomFields uyarı: ${JSON.stringify(data)}`);
  }
}

async function sendFlow(subscriberId, flowId) {
  const response = await fetch(`${API_URL}/sending/sendFlow`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      subscriber_id: subscriberId,
      flow_ns: flowId
    })
  });

  const data = await response.json();

  if (data.status !== 'success') {
    throw new Error(`sendFlow hatası: ${JSON.stringify(data)}`);
  }

  return data;
}

module.exports = {
  ensureSubscriberAndSendFlow,
  createSubscriber,
  findSubscriberByPhone,
  setCustomFields,
  sendFlow
};
