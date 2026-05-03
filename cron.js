// ============================================================
// cron.js — Günlük Onboarding Template Gönderimi
// ============================================================
// Her gün öğlen 12:00 İstanbul saati çalışır.
// Notion'dan aktif üyeleri çeker, ilgili günün flow'unu tetikler.
// Gün 0 webhook'ta gönderilir, cron Gün 1-6 için çalışır.
// 7. günden sonra durum "tamamlandı" olarak güncellenir.
// ============================================================

const cron = require('node-cron');
const moment = require('moment-timezone');
const { ONBOARDING_FLOWS } = require('./config/templates');
const { config } = require('./config/env');
const notion = require('./services/notion');
const manychat = require('./services/manychat');
const resend = require('./services/resend');
const log = require('./utils/logger');

// ─── Helpers ─────────────────────────────────────────────────
function isShuttingDown() {
  return globalThis.__SHUTTING_DOWN__ === true;
}

function isRateLimitErr(err) {
  return err?.status === 429
    || err?.code === 'rate_limited'
    || err?.statusCode === 429
    || /\b429\b/.test(err?.message || '');
}

// Faz 3 P1 #13: Geçici ağ hataları (timeout, abort, dns flap) da retry edilebilir.
// Bunlar genelde network spike'larında geliyor ve idempotent retry güvenlidir.
function isTransientNetworkErr(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = err.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND'
      || code === 'EAI_AGAIN' || code === 'ECONNREFUSED') return true;
  // fetch() timeout signal'i bazen jenerik mesajla geliyor
  if (/timeout|aborted|network/i.test(err.message || '')) return true;
  return false;
}

// P0 #6 + Faz 3 P1 #13: 429 + transient ağ hataları üzerine inline backoff retry.
// 3 deneme: 2s, 5s, 10s. Tüm denemeler başarısızsa son hatayı throw eder.
async function retryOn429(fn, label) {
  const delays = [2000, 5000, 10000];
  let lastErr;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retriable = isRateLimitErr(err) || isTransientNetworkErr(err);
      if (!retriable) throw err;
      if (attempt === delays.length - 1) break;
      const wait = delays[attempt];
      const reason = isRateLimitErr(err) ? '429' : `transient(${err.name || err.code || 'net'})`;
      log.warn(`[CRON:retry] ${label} ${reason} — ${wait}ms backoff (deneme ${attempt + 1}/${delays.length})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// dual-channel retry tracking: lastError üzerinde "channel-failed-day-N" flag.
// Format: "wa-failed-day-3" | "email-failed-day-3" | normal hata mesajı
function parseRetryFlag(lastError) {
  if (!lastError) return null;
  const m = String(lastError).match(/^(wa|email)-failed-day-(\d+)$/);
  if (!m) return null;
  return { channel: m[1], day: Number(m[2]) };
}

// ─── WhatsApp Onboarding Cron ───
cron.schedule(config.cronSchedule, async () => {
  log.info('=== Günlük onboarding cron başladı ===');

  // P1 #10 — Multi-instance run-lock
  let lockOk = false;
  try {
    lockOk = await notion.tryAcquireCronLock();
  } catch (lockErr) {
    log.error(`[CRON] Run-lock alınamadı, yine de devam: ${lockErr.message}`);
    lockOk = true; // lock fail-open — service degradation'da double-run, full-stop'tan iyidir
  }
  if (!lockOk) {
    log.warn('=== Cron skip edildi (başka bir instance bugün çalıştırmış) ===');
    return;
  }

  try {
    // ─── WhatsApp kanalı ───
    const members = await notion.getActiveOnboardingMembers();
    log.info(`${members.length} aktif WhatsApp onboarding üyesi bulundu`);

    let sent = 0;
    let skipped = 0;
    let completed = 0;
    let errors = 0;

    for (const member of members) {
      if (isShuttingDown()) {
        log.warn('[CRON] Shutdown sinyali — WA döngüsü erken kesildi');
        break;
      }
      try {
        const today = moment.tz('Europe/Istanbul').startOf('day');
        const startDay = moment.tz(member.onboardingStartDate, 'YYYY-MM-DD', 'Europe/Istanbul').startOf('day');

        if (!startDay.isValid()) {
          log.error(`[CRON] Geçersiz onboardingStartDate — memberName: ${member.firstName} ${member.lastName}, notionId: ${member.id}`);
          await notion.updatePage(member.id, {
            onboardingStatus: 'error',
            lastError: 'onboardingStartDate boş veya geçersiz',
            errorCount: (member.errorCount || 0) + 1
          });
          await resend.sendAdminAlertEmail(`[ONBOARDING] Geçersiz tarih: ${member.firstName}`, {
            name: `${member.firstName} ${member.lastName}`,
            id: member.id,
            error: 'Üyenin onboardingStartDate alanı boş veya geçersiz. Manuel müdahale gerekli.'
          });
          errors++;
          continue;
        }

        const daysDiff = today.diff(startDay, 'days');

        const expectedDay = member.onboardingStep + 1;

        // Faz 3 NEW (5am cutoff bug fix — savunmacı):
        // Day 0 webhook'tan gönderildi (step=0). Aynı gün cron çalışırsa
        // (manuel kayıt, clock skew, vs.) daysDiff=0 olur ve `0 <= 0`
        // zaten skip eder; ancak gelecek tarihli startDate (negatif diff)
        // riskine karşı açıkça `< 1` guard'ı koyuyoruz.
        if (daysDiff < 1) {
          log.info(`[CRON:wa] ${member.firstName} skip — startDate=${member.onboardingStartDate} bugün/gelecek (daysDiff=${daysDiff})`);
          skipped++;
          continue;
        }

        // Zamanı gelmediyse atla
        if (daysDiff <= member.onboardingStep) {
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

        // ManyChat'ten gönder — 429 retry sarmalı
        await retryOn429(
          () => manychat.ensureSubscriberAndSendFlow(member.phone, member.firstName, flowConfig.flow_id),
          `WA[${member.firstName}/day${expectedDay}]`
        );

        // Notion güncelle
        try {
          await notion.updatePage(member.id, {
            onboardingStep: expectedDay,
            errorCount: 0,
            lastError: ""
          });
        } catch (notionErr) {
          log.error(`[CRON] Notion step update başarısız ama mesaj gönderildi`, { member: member.firstName, error: notionErr.message });
          await resend.sendAdminAlertEmail(`[ONBOARDING] Notion Update Fail: ${member.firstName}`, {
            id: member.id,
            name: `${member.firstName} ${member.lastName}`,
            error: notionErr.message
          });
        }

        log.info(`Gün ${expectedDay} gönderildi: ${member.firstName} (${member.phone})`);
        sent++;

        // Rate limiting — 2 saniye bekle
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (memberError) {
        log.error(`Üye hatası (${member.firstName}): ${memberError.message}`, memberError.stack);

        // 429 buraya kadar geldiyse retryOn429 sonrası bile başarısızlık demek →
        // sessizce skip değil, errorCount artır ve admin alert at.
        const wasRateLimit = isRateLimitErr(memberError);

        // Dead-Letter Queue (DLQ)
        const newErrorCount = (member.errorCount || 0) + 1;
        if (newErrorCount >= 3) {
          await notion.updatePage(member.id, {
            errorCount: newErrorCount,
            lastError: memberError.message,
            onboardingStatus: "error"
          });
          log.info(`Üye error statüsüne alındı (DLQ): ${member.firstName} (${member.phone})`);

          // ALARM: DLQ'ya düştü
          await resend.sendAdminAlertEmail(`Üye DLQ'ya düştü: ${member.firstName}`, {
            id: member.id,
            name: `${member.firstName} ${member.lastName}`,
            phone: member.phone,
            channel: 'whatsapp',
            error: memberError.message,
            stack: memberError.stack,
            wasRateLimit
          });
        } else {
          await notion.updatePage(member.id, {
            errorCount: newErrorCount,
            lastError: memberError.message
          });
          if (wasRateLimit) {
            await resend.sendAdminAlertEmail(`[ONBOARDING] Persistent 429: ${member.firstName}`, {
              id: member.id,
              name: `${member.firstName} ${member.lastName}`,
              phone: member.phone,
              channel: 'whatsapp',
              error: memberError.message,
              note: '3 retry attempt sonrasi hala 429 — backoff yetersiz veya quota tukendi'
            }).catch(e => log.error('Admin alert failed', e));
          }
        }

        errors++;
        continue;
      }
    }

    // ─── Email kanalı (fallback / dual) ───
    let emailSent = 0;
    if (config.resendApiKey) {
      try {
        const emailMembers = await notion.getActiveEmailMembers();
        for (const member of emailMembers) {
          if (isShuttingDown()) {
            log.warn('[CRON] Shutdown sinyali — Email döngüsü erken kesildi');
            break;
          }
          try {
            const today = moment.tz('Europe/Istanbul').startOf('day');
            const startDay = moment.tz(member.onboardingStartDate, 'YYYY-MM-DD', 'Europe/Istanbul').startOf('day');

            if (!startDay.isValid()) {
              log.error(`[CRON] Geçersiz onboardingStartDate (Email) — memberName: ${member.firstName} ${member.lastName}, notionId: ${member.id}`);
              await notion.updatePage(member.id, {
                onboardingStatus: 'error',
                lastError: 'onboardingStartDate boş veya geçersiz',
                errorCount: (member.errorCount || 0) + 1
              });
              await resend.sendAdminAlertEmail(`[ONBOARDING] Geçersiz tarih (Email): ${member.firstName}`, {
                name: `${member.firstName} ${member.lastName}`,
                id: member.id,
                error: 'Üyenin onboardingStartDate alanı boş veya geçersiz. Manuel müdahale gerekli.'
              });
              errors++;
              continue;
            }

            const daysDiff = today.diff(startDay, 'days');

            // P0 #3 — Day 0 double-send koruması:
            // Webhook (server.js) email-status user'a Day 0 mailini zaten attı ve
            // onboardingStartDate=bugün set etti. Eğer cron aynı gün çalışırsa
            // (örn. 5am < 6 case'inde startDate=dün hesaplanabilir veya manuel kayıt
            // yapılmış olabilir), `daysDiff < 1` olduğunda hiçbir email gönderme.
            // Sadece startDate KESİNLİKLE dünden eskiyse devam et.
            if (daysDiff < 1) {
              log.info(`[CRON:email] ${member.firstName} skip — startDate=${member.onboardingStartDate} bugün/gelecek (daysDiff=${daysDiff})`);
              skipped++;
              continue;
            }

            if (daysDiff <= member.onboardingStep) continue;

            const expectedDay = member.onboardingStep + 1;

            if (expectedDay > 6) {
              await notion.updatePage(member.id, { onboardingStatus: "tamamlandı" });
              completed++;
              continue;
            }

            await retryOn429(
              () => resend.sendOnboardingEmail(member.email, member.firstName, expectedDay),
              `EMAIL[${member.firstName}/day${expectedDay}]`
            );
            try {
              await notion.updatePage(member.id, {
                onboardingStep: expectedDay,
                errorCount: 0,
                lastError: ""
              });
            } catch (notionErr) {
              log.error(`[CRON] Notion step update başarısız ama email gönderildi`, { member: member.firstName, error: notionErr.message });
              await resend.sendAdminAlertEmail(`[ONBOARDING] Notion Update Fail (Email): ${member.firstName}`, {
                id: member.id,
                name: `${member.firstName} ${member.lastName}`,
                error: notionErr.message
              });
            }
            emailSent++;

            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (emailErr) {
            log.error(`Email üye hatası (${member.firstName}): ${emailErr.message}`, emailErr.stack);

            const wasRateLimit = isRateLimitErr(emailErr);

            // Dead-Letter Queue (DLQ)
            const newErrorCount = (member.errorCount || 0) + 1;
            if (newErrorCount >= 3) {
              await notion.updatePage(member.id, {
                errorCount: newErrorCount,
                lastError: emailErr.message,
                onboardingStatus: "error"
              });
              log.info(`Email üye error statüsüne alındı (DLQ): ${member.firstName} (${member.email})`);

              // ALARM: DLQ'ya düştü
              await resend.sendAdminAlertEmail(`Email Üye DLQ'ya düştü: ${member.firstName}`, {
                id: member.id,
                name: `${member.firstName} ${member.lastName}`,
                email: member.email,
                channel: 'email',
                error: emailErr.message,
                stack: emailErr.stack,
                wasRateLimit
              });
            } else {
              await notion.updatePage(member.id, {
                errorCount: newErrorCount,
                lastError: emailErr.message
              });
              if (wasRateLimit) {
                await resend.sendAdminAlertEmail(`[ONBOARDING] Persistent 429 (Email): ${member.firstName}`, {
                  id: member.id,
                  name: `${member.firstName} ${member.lastName}`,
                  email: member.email,
                  channel: 'email',
                  error: emailErr.message,
                  note: '3 retry attempt sonrasi hala 429'
                }).catch(e => log.error('Admin alert failed', e));
              }
            }

            errors++;
          }
        }
      } catch (emailBatchErr) {
        log.error(`Email batch hatası: ${emailBatchErr.message}`, emailBatchErr.stack);
      }
    }

    // ─── Dual kanal (WhatsApp + Email aynı anda) — P1 #12 atomic ───
    let dualWaSent = 0;
    let dualEmailSent = 0;

    try {
      const dualMembers = await notion.getActiveDualMembers();
      log.info(`${dualMembers.length} aktif Dual onboarding üyesi bulundu`);

      for (const member of dualMembers) {
        if (isShuttingDown()) {
          log.warn('[CRON] Shutdown sinyali — Dual döngüsü erken kesildi');
          break;
        }
        try {
          const today = moment.tz('Europe/Istanbul').startOf('day');
          const startDay = moment.tz(member.onboardingStartDate, 'YYYY-MM-DD', 'Europe/Istanbul').startOf('day');

          if (!startDay.isValid()) {
            log.error(`[CRON-DUAL] Geçersiz onboardingStartDate — ${member.firstName}, ID: ${member.id}`);
            await notion.updatePage(member.id, {
              onboardingStatus: 'error',
              lastError: 'onboardingStartDate boş veya geçersiz (dual)',
              errorCount: (member.errorCount || 0) + 1
            });
            await resend.sendAdminAlertEmail(`[ONBOARDING] Geçersiz tarih (Dual): ${member.firstName}`, {
              name: `${member.firstName} ${member.lastName}`,
              id: member.id,
              error: 'Üyenin onboardingStartDate alanı boş veya geçersiz. Manuel müdahale gerekli.'
            });
            errors++;
            continue;
          }

          const daysDiff = today.diff(startDay, 'days');

          // P0 #3 — Day 0 double-send koruması (dual için de geçerli):
          // Webhook dual user'a hem WA Day 0 hem Email Day 0 attı.
          // Aynı günde cron tekrar göndermesin.
          if (daysDiff < 1) {
            log.info(`[CRON-DUAL] ${member.firstName} skip — startDate=${member.onboardingStartDate} bugün (daysDiff=${daysDiff})`);
            skipped++;
            continue;
          }

          // P1 #12 — Atomic dual-channel retry tracking
          // Önceki cron'da bir kanal başarısız olduysa lastError = "wa-failed-day-N"
          // veya "email-failed-day-N" şeklindedir. Bu durumda step ilerletilmemiştir.
          // Yalnızca başarısız olan kanalı yeniden dene.
          const retryFlag = parseRetryFlag(member.lastError);
          let targetDay;
          let onlyChannel = null; // "wa" | "email" | null (her ikisi)

          if (retryFlag && retryFlag.day === member.onboardingStep + 1) {
            targetDay = retryFlag.day;
            onlyChannel = retryFlag.channel;
            log.info(`[CRON-DUAL] Retry-only mode: ${member.firstName} day ${targetDay} kanal=${onlyChannel}`);
          } else {
            if (daysDiff <= member.onboardingStep) {
              skipped++;
              continue;
            }
            targetDay = member.onboardingStep + 1;
          }

          if (targetDay > 6) {
            await notion.updatePage(member.id, { onboardingStatus: "tamamlandı" });
            log.info(`[CRON-DUAL] Tamamlandı: ${member.firstName}`);
            completed++;
            continue;
          }

          // --- WhatsApp gönderimi ---
          let waSent = false;
          let waSkipped = onlyChannel === 'email'; // sadece email retry: WA atla
          let waErr = null;
          if (!waSkipped) {
            try {
              const flowConfig = ONBOARDING_FLOWS[targetDay];
              if (flowConfig && flowConfig.flow_id && !flowConfig.flow_id.startsWith('TODO_') && member.phone) {
                await retryOn429(
                  () => manychat.ensureSubscriberAndSendFlow(member.phone, member.firstName, flowConfig.flow_id),
                  `DUAL-WA[${member.firstName}/day${targetDay}]`
                );
                dualWaSent++;
                waSent = true;
              } else {
                log.warn(`[CRON-DUAL] WA atlandı (flow/phone eksik): Gün ${targetDay} — ${member.firstName}`);
                waSkipped = true; // phone/flow yoksa "atlanmış" sayılır, hata değil
              }
            } catch (e) {
              waErr = e;
              log.error(`[CRON-DUAL] WA hatası (${member.firstName}): ${e.message}`);
            }
          }

          // --- Email gönderimi ---
          let emailSentOk = false;
          let emailSkipped = onlyChannel === 'wa'; // sadece WA retry: email atla
          let emailErr = null;
          if (!emailSkipped) {
            try {
              if (member.email && member.email.includes('@')) {
                await retryOn429(
                  () => resend.sendOnboardingEmail(member.email, member.firstName, targetDay),
                  `DUAL-EMAIL[${member.firstName}/day${targetDay}]`
                );
                dualEmailSent++;
                emailSentOk = true;
              } else {
                log.warn(`[CRON-DUAL] Email atlandı (geçersiz email): ${member.firstName}`);
                emailSkipped = true;
              }
            } catch (e) {
              emailErr = e;
              log.error(`[CRON-DUAL] Email hatası (${member.firstName}): ${e.message}`);
            }
          }

          // --- Sonuç değerlendirme (P1 #12 atomic) ---
          // waSent/emailSentOk: gerçek başarı. waSkipped/emailSkipped: data eksikliği veya
          // retry-only mode'da o kanal denenmedi. waErr/emailErr: gerçek hata.
          // Step ilerlemesi için: hata almış hiçbir kanal kalmamalı.

          // Hem WA hem Email tamamen başarısız mı (gerçek hata)?
          if (waErr && emailErr) {
            const newErrorCount = (member.errorCount || 0) + 1;
            if (newErrorCount >= 3) {
              await notion.updatePage(member.id, {
                errorCount: newErrorCount,
                lastError: 'Dual: Hem WA hem Email başarısız',
                onboardingStatus: "error"
              });
              await resend.sendAdminAlertEmail(`Dual Üye DLQ'ya düştü: ${member.firstName}`, {
                id: member.id,
                name: `${member.firstName} ${member.lastName}`,
                phone: member.phone,
                email: member.email,
                channel: 'dual',
                error: `WA: ${waErr.message} | Email: ${emailErr.message}`
              });
            } else {
              await notion.updatePage(member.id, {
                errorCount: newErrorCount,
                lastError: 'Dual: Hem WA hem Email başarısız'
              });
            }
            errors++;
            continue;
          }

          // Bir kanal başarısız oldu → step ilerletme, retry flag yaz.
          // (P1 #12: Sadece TÜM yapılandırılmış kanallar başarılı olduğunda step++.)
          if (waErr || emailErr) {
            const failedChannel = waErr ? 'wa' : 'email';
            const flagStr = `${failedChannel}-failed-day-${targetDay}`;
            const newErrorCount = (member.errorCount || 0) + 1;

            if (newErrorCount >= 3) {
              // 3 retry sonrasi hala tek kanal başarısız → DLQ
              await notion.updatePage(member.id, {
                errorCount: newErrorCount,
                lastError: flagStr,
                onboardingStatus: "error"
              });
              await resend.sendAdminAlertEmail(`Dual üye tek-kanal DLQ: ${member.firstName}`, {
                id: member.id,
                name: `${member.firstName} ${member.lastName}`,
                phone: member.phone,
                email: member.email,
                channel: failedChannel,
                error: (waErr || emailErr).message,
                note: `Day ${targetDay} ${failedChannel} kanal 3 kez başarısız. Diğer kanal başarılıydı; step ilerletilmedi.`
              });
            } else {
              await notion.updatePage(member.id, {
                errorCount: newErrorCount,
                lastError: flagStr
              });
              log.warn(`[CRON-DUAL] Partial fail flagged: ${member.firstName} ${flagStr} (errorCount=${newErrorCount})`);
            }
            errors++;
            continue;
          }

          // --- Başarılı: tüm yapılandırılmış kanallar başarılı (veya skip-no-data) → step ilerle ---
          try {
            await notion.updatePage(member.id, {
              onboardingStep: targetDay,
              errorCount: 0,
              lastError: ""
            });
          } catch (notionErr) {
            log.error(`[CRON-DUAL] Notion step update başarısız: ${member.firstName}`, notionErr.message);
          }

          log.info(`[CRON-DUAL] Gün ${targetDay}: ${member.firstName} — WA:${waSent ? '✓' : (waSkipped ? '−' : '✗')} Email:${emailSentOk ? '✓' : (emailSkipped ? '−' : '✗')}`);

          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (memberError) {
          log.error(`[CRON-DUAL] Üye hatası (${member.firstName}): ${memberError.message}`, memberError.stack);

          const wasRateLimit = isRateLimitErr(memberError);

          const newErrorCount = (member.errorCount || 0) + 1;
          if (newErrorCount >= 3) {
            await notion.updatePage(member.id, {
              errorCount: newErrorCount,
              lastError: memberError.message,
              onboardingStatus: "error"
            });
            await resend.sendAdminAlertEmail(`Dual Üye DLQ'ya düştü: ${member.firstName}`, {
              id: member.id,
              name: `${member.firstName} ${member.lastName}`,
              phone: member.phone,
              email: member.email,
              channel: 'dual',
              error: memberError.message,
              stack: memberError.stack,
              wasRateLimit
            });
          } else {
            await notion.updatePage(member.id, {
              errorCount: newErrorCount,
              lastError: memberError.message
            });
          }
          errors++;
        }
      }
    } catch (dualBatchErr) {
      log.error(`[CRON-DUAL] Batch hatası: ${dualBatchErr.message}`, dualBatchErr.stack);
    }

    log.info(`=== Cron tamamlandı: WA ${sent}, Email ${emailSent}, Dual WA:${dualWaSent} Email:${dualEmailSent}, ${skipped} atlandı, ${completed} tamamlandı, ${errors} hata ===`);

  } catch (error) {
    log.error(`Cron genel hata: ${error.message}`, error.stack);
    await resend.sendAdminAlertEmail(`CRON ÇÖKTÜ`, {
      message: error.message,
      stack: error.stack
    });
  }

}, {
  timezone: config.cronTimezone
});

log.info(`Cron zamanlandı: ${config.cronSchedule} (${config.cronTimezone})`);
