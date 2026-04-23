// ============================================================
// services/notion.js — Notion CRM Katmanı
// ============================================================
// Tüm üye CRUD işlemleri bu modül üzerinden yapılır.
// Database: AI Factory WhatsApp Onboarding
// ============================================================

const { Client } = require('@notionhq/client');
const { config } = require('../config/env');
const log = require('../utils/logger');

const notion = new Client({ auth: config.notionApiKey });
const DATABASE_ID = config.notionDatabaseId;

// ─── Yeni Üye Oluştur ───
async function createMember({ firstName, lastName, email, transactionId, registrationDate, onboardingStatus }) {
  try {
    const properties = {
      'Name': { title: [{ text: { content: firstName } }] },
      'Last Name': { rich_text: [{ text: { content: lastName || '' } }] },
      'Email': { email: email || null },
      'Transaction ID': { rich_text: [{ text: { content: transactionId || '' } }] },
      'Onboarding Status': { select: { name: onboardingStatus || 'bekliyor' } }
    };

    if (registrationDate) {
      properties['Registration Date'] = { date: { start: registrationDate } };
    }

    const response = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties
    });

    log.info(`[notion] Üye oluşturuldu: ${firstName} (${response.id})`);
    return parseNotionPage(response);
  } catch (error) {
    log.error(`[notion] createMember hatası: ${error.message}`, error);
    throw error;
  }
}

// ─── Transaction ID ile Ara ───
async function findByTransactionId(transactionId) {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: 'Transaction ID',
        rich_text: { equals: transactionId }
      }
    });
    return response.results.length > 0 ? parseNotionPage(response.results[0]) : null;
  } catch (error) {
    log.error(`[notion] findByTransactionId hatası: ${error.message}`, error);
    throw error;
  }
}

// ─── Telefon ile Ara ───
async function findByPhone(phone) {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: 'Phone',
        phone_number: { equals: phone }
      }
    });
    return response.results.length > 0 ? parseNotionPage(response.results[0]) : null;
  } catch (error) {
    log.error(`[notion] findByPhone hatası: ${error.message}`, error);
    throw error;
  }
}

// ─── Sayfa Güncelle ───
async function updatePage(pageId, data) {
  try {
    const properties = {};

    if (data.phone !== undefined) properties['Phone'] = { phone_number: data.phone };
    if (data.email !== undefined) properties['Email'] = { email: data.email };
    if (data.lastName !== undefined) properties['Last Name'] = { rich_text: [{ text: { content: data.lastName } }] };
    if (data.onboardingStatus !== undefined) properties['Onboarding Status'] = { select: { name: data.onboardingStatus } };
    if (data.onboardingChannel !== undefined) properties['Onboarding Channel'] = { select: { name: data.onboardingChannel } };
    if (data.onboardingStep !== undefined) properties['Onboarding Step'] = { number: data.onboardingStep };
    if (data.notes !== undefined) properties['Notes'] = { rich_text: [{ text: { content: data.notes } }] };
    if (data.onboardingStartDate !== undefined) properties['Onboarding Start Date'] = { date: { start: data.onboardingStartDate } };

    await notion.pages.update({ page_id: pageId, properties });
    log.info(`[notion] Sayfa güncellendi: ${pageId}`);
  } catch (error) {
    log.error(`[notion] updatePage hatası: ${error.message}`, error);
    throw error;
  }
}

// ─── Aktif Onboarding Üyelerini Getir ───
async function getActiveOnboardingMembers() {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: 'Onboarding Status',
        select: { equals: 'whatsapp' }
      }
    });
    return response.results.map(parseNotionPage);
  } catch (error) {
    log.error(`[notion] getActiveOnboardingMembers hatası: ${error.message}`, error);
    throw error;
  }
}

// ─── Notion Page Parser ───
function parseNotionPage(page) {
  const props = page.properties;
  return {
    id: page.id,
    firstName: props['Name']?.title?.[0]?.text?.content || '',
    lastName: props['Last Name']?.rich_text?.[0]?.text?.content || '',
    email: props['Email']?.email || null,
    phone: props['Phone']?.phone_number || null,
    transactionId: props['Transaction ID']?.rich_text?.[0]?.text?.content || '',
    onboardingStatus: props['Onboarding Status']?.select?.name || 'bekliyor',
    onboardingChannel: props['Onboarding Channel']?.select?.name || null,
    onboardingStep: props['Onboarding Step']?.number ?? 0,
    notes: props['Notes']?.rich_text?.[0]?.text?.content || '',
    onboardingStartDate: props['Onboarding Start Date']?.date?.start || null
  };
}

module.exports = {
  createMember,
  findByTransactionId,
  findByPhone,
  updatePage,
  getActiveOnboardingMembers
};
