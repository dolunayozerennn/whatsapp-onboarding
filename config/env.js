// ============================================================
// config/env.js — Fail-Fast Environment Validation
// ============================================================
// Boot time'da tüm zorunlu env variable'ları kontrol eder.
// Eksik varsa uygulama ÇÖKER (Enterprise Stabilization Doctrine).
// ============================================================

require('dotenv').config();

const REQUIRED_VARS = [
  'NOTION_API_KEY',
  'NOTION_DATABASE_ID',
  'MANYCHAT_API_TOKEN',
  'GROQ_API_KEY'
];

// Opsiyonel — yoksa uyarı verir ama çökmez
const OPTIONAL_VARS = [
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL'
];

function validateEnv() {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);

  if (missing.length > 0) {
    console.error('==============================================');
    console.error('❌ FATAL: Zorunlu environment variable eksik!');
    console.error(`   Eksik: ${missing.join(', ')}`);
    console.error('==============================================');
    process.exit(1);
  }

  // Opsiyonel kontrol
  const missingOptional = OPTIONAL_VARS.filter(v => !process.env[v]);
  if (missingOptional.length > 0) {
    console.warn(`⚠️  Opsiyonel env yok (email fallback devre dışı): ${missingOptional.join(', ')}`);
  }
}

module.exports = {
  validateEnv,
  config: {
    port: process.env.PORT || 3000,
    notionApiKey: process.env.NOTION_API_KEY,
    notionDatabaseId: process.env.NOTION_DATABASE_ID,
    manychatApiToken: process.env.MANYCHAT_API_TOKEN,
    groqApiKey: process.env.GROQ_API_KEY,
    resendApiKey: process.env.RESEND_API_KEY || null,
    resendFromEmail: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
    cronTimezone: process.env.CRON_TIMEZONE || 'Europe/Istanbul',
    cronSchedule: process.env.CRON_SCHEDULE || '0 12 * * *'
  }
};
