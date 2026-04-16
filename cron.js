// ============================================================
// cron.js — Günlük Onboarding Template Gönderimi
// ============================================================
// Her gün öğlen 12:00 İstanbul saati çalışır.
// Notion'dan aktif üyeleri çeker, ilgili günün flow'unu tetikler.
// Gün 0 webhook'ta gönderilir, cron Gün 1-6 için çalışır.
// 7. günden sonra durum "tamamlandı" olarak güncellenir.
// ============================================================

const cron = require('node-cron');
const { ONBOARDING_FLOWS } = require('./config/templates');
const { config } = require('./config/env');
const notion = require('./services/notion');
const manychat = require('./services/manychat');
const resend = require('./services/resend');
const log = require('./utils/logger');

// ─── WhatsApp Onboarding Cron ───
cron.schedule(config.cronSchedule, async () => {
  log.info('=== Günlük onboarding cron başladı ===');

  try {
    // ─── WhatsApp kanalı ───
    const members = await notion.getActiveOnboardingMembers();
    log.info(`${members.length} aktif WhatsApp onboarding üyesi bulundu`);

    let sent = 0;
    let skipped = 0;
    let completed = 0;
    let errors = 0;

    for (const member of members) {
      try {
        const startDate = new Date(member.onboardingStartDate);
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
        const startStr = startDate.toISOString().split('T')[0];
        const daysDiff = Math.floor((new Date(todayStr) - new Date(startStr)) / (1000 * 60 * 60 * 24));

        const expectedDay = daysDiff;

        // Zaten bugünün mesajı gönderildiyse atla
        if (member.onboardingStep >= expectedDay) {
          skipped++;
          continue;
        }

        // 7. günden sonra tamamla
        if (expectedDay > 6) {
          await notion.updatePage(member.id, { onboardingStatus: "tamamlandı" });
          log.info(`Tamamlandı: ${member.firstName} ${member.lastName}`);
          completed++;
          continue;
        }

        // Flow bilgisini al
        const flowConfig = ONBOARDING_FLOWS[expectedDay];
        if (!flowConfig || !flowConfig.flow_id || flowConfig.flow_id.startsWith('TODO_')) {
          log.error(`Flow ID yapılandırılmamış: Gün ${expectedDay} — ${member.firstName} atlanıyor`);
          errors++;
          continue;
        }

        // ManyChat'ten gönder
        await manychat.ensureSubscriberAndSendFlow(
          member.phone,
          member.firstName,
          flowConfig.flow_id
        );

        // Notion güncelle
        await notion.updatePage(member.id, { onboardingStep: expectedDay });

        log.info(`Gün ${expectedDay} gönderildi: ${member.firstName} (${member.phone})`);
        sent++;

        // Rate limiting — 2 saniye bekle
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (memberError) {
        log.error(`Üye hatası (${member.firstName}): ${memberError.message}`, memberError.stack);
        errors++;
        continue;
      }
    }

    // ─── Email kanalı (fallback) ───
    let emailSent = 0;
    if (config.resendApiKey) {
      try {
        const emailMembers = await notion.getActiveEmailMembers();
        for (const member of emailMembers) {
          try {
            const startDate = new Date(member.onboardingStartDate);
            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
            const startStr = startDate.toISOString().split('T')[0];
            const daysDiff = Math.floor((new Date(todayStr) - new Date(startStr)) / (1000 * 60 * 60 * 24));

            if (member.onboardingStep >= daysDiff) continue;

            if (daysDiff > 6) {
              await notion.updatePage(member.id, { onboardingStatus: "tamamlandı" });
              completed++;
              continue;
            }

            await resend.sendOnboardingEmail(member.email, member.firstName, daysDiff);
            await notion.updatePage(member.id, { onboardingStep: daysDiff });
            emailSent++;

            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (emailErr) {
            log.error(`Email üye hatası (${member.firstName}): ${emailErr.message}`, emailErr.stack);
            errors++;
          }
        }
      } catch (emailBatchErr) {
        log.error(`Email batch hatası: ${emailBatchErr.message}`, emailBatchErr.stack);
      }
    }

    log.info(`=== Cron tamamlandı: WA ${sent} gönderildi, ${skipped} atlandı, ${completed} tamamlandı, Email ${emailSent} gönderildi, ${errors} hata ===`);

  } catch (error) {
    log.error(`Cron genel hata: ${error.message}`, error.stack);
  }

}, {
  timezone: config.cronTimezone
});

log.info(`Cron zamanlandı: ${config.cronSchedule} (${config.cronTimezone})`);
