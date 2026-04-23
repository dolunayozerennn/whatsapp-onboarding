// ============================================================
// services/manychat.js — ManyChat WhatsApp API Entegrasyonu
// ============================================================
// Subscriber oluşturma, flow tetikleme, custom field güncelleme.
// Template mesaj stratejisi:
//   - Subscriber zaten varsa → doğrudan sendFlow
//   - Yoksa → önce oluştur, sonra sendFlow
// ============================================================

const { config } = require('../config/env');
const { CUSTOM_FIELDS } = require('../config/templates');
const log = require('../utils/logger');

const BASE_URL = 'https://api.manychat.com/fb';

// ─── Subscriber Oluştur / Bul + Flow Tetikle ───
async function ensureSubscriberAndSendFlow(phone, name, flowId) {
  try {
    // 1. Subscriber'a bak
    let subscriber = await findSubscriberByPhone(phone);

    if (!subscriber) {
      // 2. Yoksa oluştur
      subscriber = await createSubscriber(phone, name);
      log.info(`[manychat] Yeni subscriber: ${phone} (${subscriber?.id || 'id bilinmiyor'})`);

      // 2.5 Subscriber oluştuktan sonra kısa bekle
      await sleep(2000);
    } else {
      log.info(`[manychat] Mevcut subscriber: ${phone} (${subscriber.id})`);
    }

    // 3. Custom field güncelle (isim)
    if (subscriber?.id) {
      await setCustomField(subscriber.id, CUSTOM_FIELDS.onboarding_name, name);
    }

    // 4. Flow'u tetikle
    await sendFlow(subscriber.id, flowId);
    log.info(`[manychat] Flow tetiklendi: ${flowId} → ${phone}`);

    return { success: true, subscriberId: subscriber.id };
  } catch (error) {
    log.error(`[manychat] ensureSubscriberAndSendFlow hatası: ${error.message}`, error);
    throw error;
  }
}

// ─── Subscriber Ara (telefon ile) ───
async function findSubscriberByPhone(phone) {
  try {
    const response = await fetch(`${BASE_URL}/subscriber/findBySystemField`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        field: 'whatsapp_phone',
        value: phone
      })
    });

    const data = await response.json();

    if (data.status === 'success' && data.data) {
      return data.data;
    }
    return null;
  } catch (error) {
    log.error(`[manychat] findSubscriberByPhone hatası: ${error.message}`, error);
    return null;
  }
}

// ─── Subscriber Oluştur ───
async function createSubscriber(phone, name) {
  try {
    const response = await fetch(`${BASE_URL}/subscriber/createSubscriber`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        phone: phone,
        first_name: name,
        whatsapp_phone: phone,
        has_opt_in_whatsapp: true,
        consent_phrase: 'AI Factory Onboarding System'
      })
    });

    const data = await response.json();

    if (data.status === 'success') {
      return data.data;
    }

    log.warn(`[manychat] createSubscriber uyarı: ${JSON.stringify(data)}`);
    return null;
  } catch (error) {
    log.error(`[manychat] createSubscriber hatası: ${error.message}`, error);
    throw error;
  }
}

// ─── Flow Tetikle ───
async function sendFlow(subscriberId, flowNamespace) {
  try {
    const response = await fetch(`${BASE_URL}/sending/sendFlow`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        subscriber_id: subscriberId,
        flow_ns: flowNamespace
      })
    });

    const data = await response.json();

    if (data.status !== 'success') {
      log.warn(`[manychat] sendFlow başarısız: ${JSON.stringify(data)}`);
      throw new Error(`sendFlow hatası: ${data.message || JSON.stringify(data)}`);
    }

    return data;
  } catch (error) {
    log.error(`[manychat] sendFlow hatası: ${error.message}`, error);
    throw error;
  }
}

// ─── Custom Field Güncelle ───
async function setCustomField(subscriberId, fieldId, value) {
  try {
    const response = await fetch(`${BASE_URL}/subscriber/setCustomField`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        subscriber_id: subscriberId,
        field_id: fieldId,
        field_value: value
      })
    });

    const data = await response.json();

    if (data.status !== 'success') {
      log.warn(`[manychat] setCustomField başarısız: ${JSON.stringify(data)}`);
    }
    return data;
  } catch (error) {
    log.error(`[manychat] setCustomField hatası: ${error.message}`, error);
  }
}

// ─── Subscriber'a Tag Ekle ───
async function addTag(subscriberId, tagName) {
  try {
    const response = await fetch(`${BASE_URL}/subscriber/addTag`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        subscriber_id: subscriberId,
        tag_name: tagName
      })
    });

    return await response.json();
  } catch (error) {
    log.error(`[manychat] addTag hatası: ${error.message}`, error);
  }
}

// ─── Headers ───
function getHeaders() {
  return {
    'Authorization': `Bearer ${config.manychatApiToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

// ─── Sleep Utility ───
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  ensureSubscriberAndSendFlow,
  findSubscriberByPhone,
  createSubscriber,
  sendFlow,
  setCustomField,
  addTag
};
