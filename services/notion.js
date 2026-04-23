// ============================================================
// services/notion.js — Notion CRM CRUD İşlemleri
// ============================================================
// Onboarding veritabanı: 0a84f19d-8dd4-4c08-9226-71d9ce71411f
// ============================================================

const { Client } = require('@notionhq/client');
const { config } = require('../config/env');
const log = require('../utils/logger');

const notion = new Client({ auth: config.notionApiKey });
const DATABASE_ID = config.notionDatabaseId;

// ─── Notion Database Şeması ───
// İsim (title), Soyisim (text), Email (email), Telefon (phone_number),
// Skool ID (number), Kayıt Tarihi (date), Onboarding Durumu (select),
// Onboarding Kanalı (select), Onboarding Adımı (number),
// Onboarding Başlangıcı (date), Notlar (text)

async function findByTransactionId(transactionId) {
  const id = parseInt(transactionId);
  if (isNaN(id)) return null;

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "Skool ID",
      number: { equals: id }
    }
  });

  if (response.results.length === 0) return null;
  return parseMember(response.results[0]);
}

async function findByPhone(phone) {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "Telefon",
      phone_number: { equals: phone }
    }
  });

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
  if (transactionId) properties["Skool ID"] = { number: parseInt(transactionId) };
  if (registrationDate) properties["Kayıt Tarihi"] = { date: { start: registrationDate } };

  const page = await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties
  });

  log.info(`[notion] Yeni üye oluşturuldu: ${firstName} (${page.id})`);
  return parseMember(page);
}

async function updatePage(pageId, updates) {
  const properties = {};

  if (updates.email !== undefined) properties["Email"] = { email: updates.email };
  if (updates.lastName !== undefined) properties["Soyisim"] = { rich_text: [{ text: { content: updates.lastName } }] };
  if (updates.phone) properties["Telefon"] = { phone_number: updates.phone };
  if (updates.onboardingStatus) properties["Onboarding Durumu"] = { select: { name: updates.onboardingStatus } };
  if (updates.onboardingChannel) properties["Onboarding Kanalı"] = { select: { name: updates.onboardingChannel } };
  if (updates.onboardingStep !== undefined) properties["Onboarding Adımı"] = { number: updates.onboardingStep };
  if (updates.onboardingStartDate) properties["Onboarding Başlangıcı"] = { date: { start: updates.onboardingStartDate } };
  if (updates.notes) properties["Notlar"] = { rich_text: [{ text: { content: updates.notes } }] };
  if (updates.errorCount !== undefined) properties["errorCount"] = { number: updates.errorCount };
  if (updates.lastError !== undefined) properties["lastError"] = { rich_text: [{ text: { content: updates.lastError } }] };

  await notion.pages.update({ page_id: pageId, properties });
}

async function getActiveOnboardingMembers() {
  const allMembers = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        and: [
          { property: "Onboarding Durumu", select: { equals: "whatsapp" } },
          { property: "Telefon", phone_number: { is_not_empty: true } }
        ]
      },
      start_cursor: startCursor
    });

    allMembers.push(...response.results.map(parseMember));
    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }

  return allMembers;
}

async function getActiveEmailMembers() {
  const allMembers = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        and: [
          { property: "Onboarding Durumu", select: { equals: "email" } },
          { property: "Email", email: { is_not_empty: true } }
        ]
      },
      start_cursor: startCursor
    });

    allMembers.push(...response.results.map(parseMember));
    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }

  return allMembers;
}

function parseMember(page) {
  return {
    id: page.id,
    firstName: page.properties["İsim"]?.title?.[0]?.text?.content || '',
    lastName: page.properties["Soyisim"]?.rich_text?.[0]?.text?.content || '',
    email: page.properties["Email"]?.email || '',
    phone: page.properties["Telefon"]?.phone_number || '',
    onboardingStatus: page.properties["Onboarding Durumu"]?.select?.name || '',
    onboardingStep: page.properties["Onboarding Adımı"]?.number || 0,
    onboardingStartDate: page.properties["Onboarding Başlangıcı"]?.date?.start || '',
    onboardingChannel: page.properties["Onboarding Kanalı"]?.select?.name || '',
    errorCount: page.properties["errorCount"]?.number || 0,
    lastError: page.properties["lastError"]?.rich_text?.[0]?.text?.content || '',
    notes: page.properties["Notlar"]?.rich_text?.[0]?.text?.content || '',
  };
}

module.exports = {
  findByTransactionId,
  findByPhone,
  createMember,
  updatePage,
  getActiveOnboardingMembers,
  getActiveEmailMembers
};
