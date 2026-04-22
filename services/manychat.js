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
  const context = { phoneNumber, firstName, flowId };
  
  log.info(`[manychat:engine] Flow tetikleme işlemi başlatıldı.`, context);

  // 1. Subscriber'ı bulmaya çalış (custom field üzerinden)
  subscriberId = await findSubscriberByPhone(phoneNumber);
  log.debug(`[manychat:engine] Arama sonucu:`, { subscriberId });

  if (!subscriberId) {
    // 2. Yoksa oluştur
    log.info(`[manychat:engine] Subscriber bulunamadı, oluşturuluyor...`);
    subscriberId = await createSubscriber(phoneNumber, firstName);
  } else {
    log.info(`[manychat:engine] Mevcut subscriber bulundu, oluşturma adımı atlanıyor.`);
  }

  if (!subscriberId) {
    const errMsg = `Subscriber ID alınamadı (ne yaratılabildi ne de bulunabildi).`;
    log.error(`[manychat:engine] FATAL: ${errMsg}`, context);
    throw new Error(errMsg);
  }

  // 3. Custom field'ları güncelle (template değişkenleri için)
  log.debug(`[manychat:engine] Custom fields güncelleniyor...`, { subscriberId });
  await setCustomFields(subscriberId, {
    onboarding_name: firstName,
    whatsapp_phone_text: phoneNumber
  });

  // 4. Flow'u tetikle (template mesajı bu flow'un içinde)
  log.info(`[manychat:engine] Flow gönderimi çağrılıyor...`, { subscriberId, flowId });
  const flowResult = await sendFlow(subscriberId, flowId);

  log.info(`[manychat:engine] ✅ Flow gönderimi başarıyla tamamlandı.`, { 
    subscriberId, 
    flowId, 
    manychatStatus: flowResult.status 
  });
  
  return subscriberId;
}

async function createSubscriber(phoneNumber, firstName) {
  try {
    const payload = {
      first_name: firstName,
      whatsapp_phone: phoneNumber,
      consent_phrase: "onboarding"
    };
    
    log.debug(`[manychat:api] createSubscriber isteği atılıyor.`, payload);
    
    const response = await fetch(`${API_URL}/subscriber/createSubscriber`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    log.debug(`[manychat:api] createSubscriber yanıtı.`, data);

    if (data.status === 'success') {
      log.info(`[manychat:api] ✅ Yeni subscriber oluşturuldu: ${phoneNumber}`, { id: data.data.id });
      return data.data.id;
    }

    // Subscriber zaten varsa hata döner — normal, findByCustomField ile bul
    log.warn(`[manychat:api] ⚠️ createSubscriber başarısız (büyük ihtimalle mevcut).`, { message: data.message });
    return await findSubscriberByPhone(phoneNumber);

  } catch (error) {
    log.error(`[manychat:api] ❌ createSubscriber ağ hatası: ${error.message}`, error);
    throw error;
  }
}

async function findSubscriberByPhone(phoneNumber) {
  try {
    const payload = {
      field_name: "whatsapp_phone_text",
      field_value: phoneNumber
    };
    
    log.debug(`[manychat:api] findByCustomField isteği atılıyor.`, payload);
    
    const response = await fetch(`${API_URL}/subscriber/findByCustomField`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    log.debug(`[manychat:api] findByCustomField yanıtı.`, data);

    if (data.status === 'success' && data.data) {
      log.info(`[manychat:api] ✅ Subscriber başarıyla bulundu.`, { id: data.data.id });
      return data.data.id;
    }

    log.info(`[manychat:api] ℹ️ Subscriber bulunamadı.`);
    return null;
  } catch (error) {
    log.error(`[manychat:api] ❌ findByCustomField ağ hatası: ${error.message}`, error);
    return null;
  }
}

async function setCustomFields(subscriberId, fields) {
  const fieldArray = Object.entries(fields).map(([name, value]) => ({
    field_name: name,
    field_value: String(value)
  }));

  const payload = {
    subscriber_id: subscriberId,
    fields: fieldArray
  };

  log.debug(`[manychat:api] setCustomFields isteği atılıyor.`, payload);

  const response = await fetch(`${API_URL}/subscriber/setCustomFields`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  log.debug(`[manychat:api] setCustomFields yanıtı.`, data);

  if (data.status !== 'success') {
    log.warn(`[manychat:api] ⚠️ setCustomFields başarısız/uyarı:`, data);
  } else {
    log.info(`[manychat:api] ✅ Custom Fields güncellendi.`);
  }
}

async function sendFlow(subscriberId, flowId) {
  const payload = {
    subscriber_id: subscriberId,
    flow_ns: flowId
  };
  
  log.debug(`[manychat:api] sendFlow isteği atılıyor.`, payload);

  const response = await fetch(`${API_URL}/sending/sendFlow`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  log.debug(`[manychat:api] sendFlow yanıtı.`, data);

  if (data.status !== 'success') {
    log.error(`[manychat:api] ❌ sendFlow başarısız.`, data);
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