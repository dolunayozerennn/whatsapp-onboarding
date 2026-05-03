// ============================================================
// services/notion.js — Notion CRM CRUD İşlemleri
// ============================================================
// Onboarding veritabanı: 0a84f19d-8dd4-4c08-9226-71d9ce71411f
// ============================================================

const { Client } = require('@notionhq/client');
const { config } = require('../config/env');
const log = require('../utils/logger');
const { toE164 } = require('../utils/phone');

// Faz 3 P1 #13: Notion SDK'nın internal fetch'ine timeout ver. SDK zaten
// kendi içinde retry yapıyor, ama tek istek için üst sınır koymak da gerekli.
const notion = new Client({
  auth: config.notionApiKey,
  timeoutMs: 15000
});
const DATABASE_ID = config.notionDatabaseId;

// Faz 3 P1 #14: Cron iterasyonunda max çekilecek üye sayısı.
// 100 page_size × 10 sayfa = 1000 üye/cron. Bu cap'e gelirsek scale gerek var.
const MAX_PAGES_PER_QUERY = 10;
const PAGE_SIZE = 100;

async function notionRequest(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.status === 429 && attempt < maxRetries) {
        const waitMs = (err?.headers?.['retry-after'] || 1) * 1000;
        log.warn(`[NOTION] Rate limited, ${waitMs}ms bekleniyor...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}


// ─── Notion Database Şeması ───
// İsim (title), Soyisim (text), Email (email), Telefon (phone_number),
// Skool ID (rich_text), Kayıt Tarihi (date), Onboarding Durumu (select),
// Onboarding Kanalı (select), Onboarding Adımı (number),
// Onboarding Başlangıcı (date), Notlar (text)

async function findByTransactionId(transactionId) {
  if (!transactionId) return null;

  const response = await notionRequest(() => notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "Skool ID",
      rich_text: { equals: String(transactionId) }
    },
    page_size: 1 // Faz 3 P1 #14: lookup — sadece tek satır gerekli
  }));

  if (response.results.length === 0) return null;
  return parseMember(response.results[0]);
}

async function findByPhone(phone) {
  // Faz 3 P1 #16: Phone lookup öncesi E.164'e normalize et.
  const normalized = phone ? toE164(phone) || phone : phone;
  if (!normalized) return null;

  const response = await notionRequest(() => notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "Telefon",
      phone_number: { equals: normalized }
    },
    page_size: 1
  }));

  if (response.results.length === 0) return null;
  return parseMember(response.results[0]);
}

async function findByEmail(email) {
  if (!email) return null;

  const response = await notionRequest(() => notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "Email",
      email: { equals: email }
    },
    page_size: 1
  }));

  if (response.results.length === 0) return null;
  return parseMember(response.results[0]);
}

async function findByName(firstName, lastName) {
  if (!firstName) return null;

  const filter = {
    and: [
      {
        property: "İsim",
        title: { equals: firstName }
      }
    ]
  };

  if (lastName && lastName !== "No data" && lastName.trim() !== "") {
    filter.and.push({
      property: "Soyisim",
      rich_text: { equals: lastName }
    });
  } else {
    filter.and.push({
      property: "Soyisim",
      rich_text: { is_empty: true }
    });
  }

  const response = await notionRequest(() => notion.databases.query({
    database_id: DATABASE_ID,
    filter: filter,
    page_size: 1
  }));

  if (response.results.length === 0) return null;
  return parseMember(response.results[0]);
}

async function createMember({ firstName, lastName, email, transactionId, registrationDate, onboardingStatus }) {
  const properties = {
    "İsim": { title: [{ text: { content: firstName } }] },
    "Onboarding Durumu": { select: { name: onboardingStatus || "bekliyor" } }
  };

  if (lastName) properties["Soyisim"] = { rich_text: [{ text: { content: lastName } }] };
  if (email) properties["Email"] = { email: email };
  if (transactionId) properties["Skool ID"] = { rich_text: [{ text: { content: String(transactionId) } }] };
  if (registrationDate) properties["Kayıt Tarihi"] = { date: { start: registrationDate } };

  const page = await notionRequest(() => notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties
  }));

  log.info(`[notion] Yeni üye oluşturuldu: ${firstName} (${page.id})`);
  return parseMember(page);
}

async function updatePage(pageId, updates) {
  const properties = {};

  if (updates.email !== undefined) properties["Email"] = { email: updates.email };
  if (updates.lastName !== undefined) properties["Soyisim"] = { rich_text: [{ text: { content: updates.lastName } }] };
  if (updates.registrationDate !== undefined) properties["Kayıt Tarihi"] = { date: { start: updates.registrationDate } };
  if (updates.phone) {
    // Faz 3 P1 #16: Notion'a yazılan telefon her zaman E.164.
    const normalizedPhone = toE164(updates.phone) || updates.phone;
    properties["Telefon"] = { phone_number: normalizedPhone };
  }
  if (updates.onboardingStatus) properties["Onboarding Durumu"] = { select: { name: updates.onboardingStatus } };
  if (updates.onboardingChannel) properties["Onboarding Kanalı"] = { select: { name: updates.onboardingChannel } };
  if (updates.onboardingStep !== undefined) properties["Onboarding Adımı"] = { number: updates.onboardingStep };
  if (updates.onboardingStartDate) properties["Onboarding Başlangıcı"] = { date: { start: updates.onboardingStartDate } };
  if (updates.notes) properties["Notlar"] = { rich_text: [{ text: { content: updates.notes } }] };
  if (updates.errorCount !== undefined) properties["errorCount"] = { number: updates.errorCount };
  if (updates.lastError !== undefined) {
    const safeError = String(updates.lastError).slice(0, 1900);
    properties["lastError"] = { rich_text: [{ text: { content: safeError } }] };
  }

  await notionRequest(() => notion.pages.update({ page_id: pageId, properties }));
}

// Faz 3 P1 #14: Bounded pagination — page_size + max sayfa cap.
// Cap'e gelirsek warn log; bu noktada queue/batch refactor düşünülmeli.
async function paginatedQuery(label, filter) {
  const allMembers = [];
  let hasMore = true;
  let startCursor = undefined;
  let pageCount = 0;

  while (hasMore && pageCount < MAX_PAGES_PER_QUERY) {
    const response = await notionRequest(() => notion.databases.query({
      database_id: DATABASE_ID,
      filter,
      start_cursor: startCursor,
      page_size: PAGE_SIZE
    }));

    allMembers.push(...response.results.map(parseMember));
    hasMore = response.has_more;
    startCursor = response.next_cursor;
    pageCount++;
  }

  if (hasMore) {
    log.warn(`[notion:${label}] Hard cap'e ulaşıldı (${pageCount * PAGE_SIZE} üye okundu, daha var). ` +
            `Bir sonraki cron iterasyonunda devamı işlenecek; scale gerekiyor olabilir.`);
  }

  return allMembers;
}

async function getActiveOnboardingMembers() {
  return paginatedQuery('whatsapp', {
    and: [
      { property: "Onboarding Durumu", select: { equals: "whatsapp" } },
      { property: "Telefon", phone_number: { is_not_empty: true } }
    ]
  });
}

async function getActiveEmailMembers() {
  return paginatedQuery('email', {
    and: [
      { property: "Onboarding Durumu", select: { equals: "email" } },
      { property: "Email", email: { is_not_empty: true } }
    ]
  });
}

async function getActiveDualMembers() {
  return paginatedQuery('dual', {
    and: [
      { property: "Onboarding Durumu", select: { equals: "dual" } },
      { property: "Telefon", phone_number: { is_not_empty: true } },
      { property: "Email", email: { is_not_empty: true } }
    ]
  });
}

function parseMember(page) {
  return {
    id: page.id,
    firstName: (page.properties["İsim"]?.title?.[0]?.text?.content || '').trim(),
    lastName: (page.properties["Soyisim"]?.rich_text?.[0]?.text?.content || '').trim(),
    email: page.properties["Email"]?.email || '',
    phone: page.properties["Telefon"]?.phone_number || '',
    registrationDate: page.properties["Kayıt Tarihi"]?.date?.start || '',
    onboardingStatus: page.properties["Onboarding Durumu"]?.select?.name || '',
    onboardingStep: page.properties["Onboarding Adımı"]?.number || 0,
    onboardingStartDate: page.properties["Onboarding Başlangıcı"]?.date?.start || '',
    onboardingChannel: page.properties["Onboarding Kanalı"]?.select?.name || '',
    errorCount: page.properties["errorCount"]?.number || 0,
    lastError: page.properties["lastError"]?.rich_text?.[0]?.text?.content || '',
    notes: page.properties["Notlar"]?.rich_text?.[0]?.text?.content || '',
  };
}

// ─── NOT EKLEME HELPER ────────────────────────────────────────
// Mevcut notları silmeden yeni not ekler. Notion rich_text 2000 karakter limiti.
async function appendNote(pageId, newNote) {
  try {
    const page = await notionRequest(() => notion.pages.retrieve({ page_id: pageId }));
    const existing = page.properties["Notlar"]?.rich_text?.[0]?.text?.content || '';
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `[${timestamp}] ${newNote}`;
    const combined = existing ? `${existing}\n${entry}` : entry;
    const trimmed = combined.slice(-2000); // Son 2000 karakter (en güncel notlar)
    
    await updatePage(pageId, { notes: trimmed });
    log.info(`[notion] Not eklendi: ${pageId} → ${entry.slice(0, 80)}...`);
  } catch (error) {
    log.error(`[notion] appendNote hatası (${pageId}): ${error.message}`);
  }
}

// ─── Cron Run-Lock (Multi-Instance Protection) ────────────────
// Notion DB içinde özel bir "lock row" kullanılır. Bu satır:
//   - İsim: "__CRON_RUN_LOCK__"
//   - Onboarding Durumu: "atlandı" (var olan filter'ların dışında kalsın diye)
//   - Notlar: son çalışma zaman damgası (ISO)
// 23.5h içinde başlatılmış bir run varsa bu cron skip edilir.
const CRON_LOCK_TITLE = "__CRON_RUN_LOCK__";
const CRON_LOCK_TTL_MS = 23.5 * 60 * 60 * 1000;

async function findCronLockPage() {
  const response = await notionRequest(() => notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "İsim",
      title: { equals: CRON_LOCK_TITLE }
    },
    page_size: 1
  }));
  return response.results[0] || null;
}

// Daily run-lock check + acquire. Returns true if lock acquired (run should proceed).
// Returns false if another instance has already started a run within TTL.
async function tryAcquireCronLock() {
  const now = new Date();
  const nowIso = now.toISOString();

  let lockPage = await findCronLockPage();

  if (lockPage) {
    const notesContent = lockPage.properties["Notlar"]?.rich_text?.[0]?.text?.content || '';
    // Format: "lastRun=2025-01-20T09:00:00.000Z"
    const match = notesContent.match(/lastRun=([\d\-T:.Z]+)/);
    if (match) {
      const lastRun = new Date(match[1]);
      if (!isNaN(lastRun.getTime()) && (now.getTime() - lastRun.getTime()) < CRON_LOCK_TTL_MS) {
        log.warn(`[NOTION:cron-lock] Another run already started at ${match[1]} — skipping`);
        return false;
      }
    }
    // Update existing lock page
    await notionRequest(() => notion.pages.update({
      page_id: lockPage.id,
      properties: {
        "Notlar": { rich_text: [{ text: { content: `lastRun=${nowIso}` } }] }
      }
    }));
  } else {
    // Create lock page
    await notionRequest(() => notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        "İsim": { title: [{ text: { content: CRON_LOCK_TITLE } }] },
        "Onboarding Durumu": { select: { name: "atlandı" } },
        "Notlar": { rich_text: [{ text: { content: `lastRun=${nowIso}` } }] }
      }
    }));
  }

  log.info(`[NOTION:cron-lock] Acquired @ ${nowIso}`);
  return true;
}

// ─── Boot Validation: Notion Select Option Drift Kontrolü ─────
// Kod aşağıdaki select'lere yazıyor — Notion'daki şemada bu opsiyonların
// hepsi mevcut olmalı; biri silinmiş/yeniden adlandırılmışsa runtime'da
// silent fail riski var (Notion bilinmeyen option'da hata yerine "null" yazabilir).
const EXPECTED_SCHEMA = {
  "Onboarding Durumu": {
    type: "select",
    options: ["bekliyor", "whatsapp", "email", "dual", "tamamlandı", "error", "atlandı"]
  },
  "Onboarding Kanalı": {
    type: "select",
    options: ["whatsapp", "email", "dual"]
  }
};

async function validateSchema() {
  const db = await notionRequest(() => notion.databases.retrieve({ database_id: DATABASE_ID }));
  const props = db.properties || {};
  const errors = [];

  for (const [propName, expected] of Object.entries(EXPECTED_SCHEMA)) {
    const prop = props[propName];
    if (!prop) {
      errors.push(`Property bulunamadı: "${propName}"`);
      continue;
    }
    if (prop.type !== expected.type) {
      errors.push(`Property "${propName}" tipi yanlış: beklenen=${expected.type}, gerçek=${prop.type}`);
      continue;
    }
    const actualOptions = (prop[expected.type]?.options || []).map(o => o.name);
    const missing = expected.options.filter(opt => !actualOptions.includes(opt));
    if (missing.length > 0) {
      errors.push(`Property "${propName}" şu opsiyonlar eksik: [${missing.join(', ')}] — mevcut: [${actualOptions.join(', ')}]`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Notion şema drift tespit edildi:\n${errors.map(e => '  - ' + e).join('\n')}`);
  }

  log.info(`[notion:validate] ✅ Şema doğrulandı (${Object.keys(EXPECTED_SCHEMA).length} property kontrol edildi).`);
}

module.exports = {
  findByTransactionId,
  findByPhone,
  findByEmail,
  findByName,
  createMember,
  updatePage,
  getActiveOnboardingMembers,
  getActiveEmailMembers,
  getActiveDualMembers,
  appendNote,
  validateSchema,
  tryAcquireCronLock
};
