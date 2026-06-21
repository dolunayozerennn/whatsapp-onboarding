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
const { decide } = require('./services/decision');
const { config } = require('./config/env');
const notion = require('./services/notion');
const manychat = require('./services/manychat');
const resend = require('./services/resend');
const { isPermanentError, shouldDemoteDualToEmail } = require('./services/wa_error');
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

// NOT: isPermanentError + shouldDemoteDualToEmail artık services/wa_error.js'te
// (saf + test edilebilir). cron.js onları yukarıda require ediyor.

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
        // SAF KARAR: hangi gün / hangi flow / hangi kanal (services/decision.js).
        // Yan-etkiler (gönderme, Notion güncelleme, alarm) burada uygulanır.
        const decision = decide(member, undefined, 'whatsapp');

        if (decision.action === 'invalid_date') {
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

        if (decision.action === 'skip_not_due') {
          if (decision.reason === 'today_or_future') {
            log.info(`[CRON:wa] ${member.firstName} skip — startDate=${member.onboardingStartDate} bugün/gelecek`);
          }
          skipped++;
          continue;
        }

        // 7. günden sonra tamamla
        if (decision.action === 'complete') {
          await notion.updatePage(member.id, { onboardingStatus: "tamamlandı" });
          log.info(`Tamamlandı: ${member.firstName} ${member.lastName}`);
          completed++;
          continue;
        }

        // Flow yapılandırılmamış
        if (decision.action === 'flow_unconfigured') {
          log.error(`Flow ID yapılandırılmamış: Gün ${decision.day} — ${member.firstName} atlanıyor`);
          errors++;
          continue;
        }

        const expectedDay = decision.day;

        // ManyChat'ten gönder — 429 retry sarmalı
        await retryOn429(
          () => manychat.ensureSubscriberAndSendFlow(member.phone, member.firstName, decision.flow.flow_id),
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
        // WA_ID_INVALID + email mevcut → sessizce email-only kanalına geçir, alarm yok.
        // (server.js webhook'unda da aynı davranış — bu, WA-only loop'ta tekrar sahnede.)
        const memberHasEmail = member.email && typeof member.email === 'string' && member.email.includes('@');
        if (memberError && memberError.code === 'WA_ID_INVALID' && memberHasEmail) {
          log.info(`[CRON:wa] WA_ID_INVALID + email mevcut → email-only akışına alındı (sessiz): ${member.firstName} (${member.phone})`);
          await notion.updatePage(member.id, {
            onboardingStatus: 'email',
            onboardingChannel: 'email',
            errorCount: 0,
            lastError: ''
          });
          await notion.appendNote(member.id, `[CRON:wa] WhatsApp hesabı bulunamadı (wa_id), email-only akışına alındı.`);
          skipped++;
          continue;
        }

        log.error(`Üye hatası (${member.firstName}): ${memberError.message}`, memberError.stack);

        // 429 buraya kadar geldiyse retryOn429 sonrası bile başarısızlık demek →
        // sessizce skip değil, errorCount artır ve admin alert at.
        const wasRateLimit = isRateLimitErr(memberError);
        const isPermanent = isPermanentError(memberError);

        // Dead-Letter Queue (DLQ)
        const newErrorCount = (member.errorCount || 0) + 1;
        // Kalıcı hata → 3-strike beklemeden hemen DLQ.
        if (newErrorCount >= 3 || isPermanent) {
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
            wasRateLimit,
            permanent: isPermanent
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
            const decision = decide(member, undefined, 'email');

            if (decision.action === 'invalid_date') {
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

            // P0 #3 — Day 0 double-send koruması:
            // today_or_future → skipped++ (bugün/gelecek tarihli).
            // step_caught_up → sessiz continue (zamanı gelmedi, sayaç artmaz —
            // orijinal davranış birebir korundu).
            if (decision.action === 'skip_not_due') {
              if (decision.reason === 'today_or_future') {
                log.info(`[CRON:email] ${member.firstName} skip — startDate=${member.onboardingStartDate} bugün/gelecek`);
                skipped++;
              }
              continue;
            }

            if (decision.action === 'complete') {
              await notion.updatePage(member.id, { onboardingStatus: "tamamlandı" });
              completed++;
              continue;
            }

            const expectedDay = decision.day;

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
            const isPermanent = isPermanentError(emailErr);

            // Dead-Letter Queue (DLQ)
            const newErrorCount = (member.errorCount || 0) + 1;
            // Kalıcı hata → 3-strike beklemeden hemen DLQ.
            if (newErrorCount >= 3 || isPermanent) {
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
                wasRateLimit,
                permanent: isPermanent
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
          const decision = decide(member, undefined, 'dual');

          if (decision.action === 'invalid_date') {
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

          // P0 #3 + P1 #12: bugün/gelecek VE step-caught-up → skip (orijinalde
          // ikisi de skipped++ idi, korundu).
          if (decision.action === 'skip_not_due') {
            if (decision.reason === 'today_or_future') {
              log.info(`[CRON-DUAL] ${member.firstName} skip — startDate=${member.onboardingStartDate} bugün`);
            }
            skipped++;
            continue;
          }

          const targetDay = decision.day;
          const onlyChannel = decision.retryOnly; // "wa" | "email" | null
          if (onlyChannel) {
            log.info(`[CRON-DUAL] Retry-only mode: ${member.firstName} day ${targetDay} kanal=${onlyChannel}`);
          }

          if (decision.action === 'complete') {
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
              if (decision.flow && member.phone) {
                await retryOn429(
                  () => manychat.ensureSubscriberAndSendFlow(member.phone, member.firstName, decision.flow.flow_id),
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
            const isPermanent = isPermanentError(waErr) && isPermanentError(emailErr);
            if (newErrorCount >= 3 || isPermanent) {
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

          // KALICI WhatsApp hatası + email başarılı → email-only'ye düşür (donmayı engelle).
          // Eskiden yalnızca tipli WA_ID_INVALID/WA_UNREACHABLE bu yola giriyordu; diğer
          // KALICI WhatsApp hataları (ör. Meta 131xxx teslim kodu, jenerik sendFlow 4xx)
          // üyeyi email çalışsa bile "error"da donduruyordu (Bayram vakası, 2026-06-21 denetim).
          // Artık herhangi bir kalıcı WA hatasında, email gittiyse onboarding email'de devam eder.
          // Geçici WA hataları bu gate'e girmez → aşağıdaki retry-flag yoluna düşer (WA tekrar denenir).
          if (shouldDemoteDualToEmail(waErr, emailErr, emailSentOk)) {
            await notion.updatePage(member.id, {
              onboardingStep: targetDay,
              onboardingStatus: 'email',
              onboardingChannel: 'email',
              errorCount: 0,
              lastError: ''
            });
            const sebep = (waErr.code === 'WA_ID_INVALID')
              ? `WhatsApp hesabı bulunamadı (wa_id)`
              : (waErr.code === 'WA_UNREACHABLE')
                ? `WhatsApp ulaşılamadı (Meta engeli)`
                : `WhatsApp kalıcı hata verdi`;
            await notion.appendNote(member.id, `[CRON-DUAL] ${sebep}, email-only akışına alındı (donma engellendi). Day ${targetDay}.`);
            log.info(`[CRON-DUAL] Kalıcı WA hatası → email-only: ${member.firstName} day ${targetDay} (${waErr.code || 'generic-permanent'})`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }

          // Bir kanal başarısız oldu → step ilerletme, retry flag yaz.
          // (P1 #12: Sadece TÜM yapılandırılmış kanallar başarılı olduğunda step++.)
          if (waErr || emailErr) {
            const failedChannel = waErr ? 'wa' : 'email';
            const flagStr = `${failedChannel}-failed-day-${targetDay}`;
            const newErrorCount = (member.errorCount || 0) + 1;
            const isPermanent = isPermanentError(waErr || emailErr);

            if (newErrorCount >= 3 || isPermanent) {
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
          const isPermanent = isPermanentError(memberError);

          const newErrorCount = (member.errorCount || 0) + 1;
          if (newErrorCount >= 3 || isPermanent) {
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

    // ─── Takılı üye nöbetçisi (Watchdog) — sessiz kaybı görünür kıl ───
    // "bekliyor"da takılı GERÇEK üyeler (ödedi ama Zap #2 hiç gelmedi) hiçbir
    // döngüde işlenmez ve hiç uyarı üretmez. Burada kullanılabilir kanalı
    // (email veya telefon) olan, 2+ gündür bekleyen ve daha önce raporlanmamış
    // üyeleri TEK seferlik admin digest'inde bildiririz. Her üye yalnız bir kez
    // raporlanır (Notlar'a "[WATCHDOG-ALERTED]" markeri yazılır → tekrar etmez).
    try {
      const stuck = await notion.getStuckBekliyorMembers();
      const nowMs = Date.now();
      const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
      const toAlert = stuck.filter(m => {
        if (m.firstName === '__CRON_RUN_LOCK__') return false;
        const hasChannel = (m.email && m.email.includes('@')) || (m.phone && m.phone.length > 5);
        if (!hasChannel) return false; // kanalsız = eksik kayıt, kapsam dışı (Dolunay: free/eski yoksay)
        if ((m.notes || '').includes('[WATCHDOG-ALERTED]')) return false; // zaten raporlandı
        // 2+ gündür bekliyor mu? (kayıt tarihi varsa ona bak, yoksa raporla)
        if (m.registrationDate) {
          const regMs = Date.parse(m.registrationDate);
          if (!isNaN(regMs) && (nowMs - regMs) < TWO_DAYS) return false; // çok yeni, zaman tanı
        }
        return true;
      });

      if (toAlert.length > 0) {
        const lines = toAlert.map(m =>
          `• ${m.firstName} ${m.lastName} — ${m.email ? 'e-posta var' : 'telefon var'}, ${m.registrationDate || 'kayıt tarihi yok'} (id: ${m.id})`
        ).join('\n');
        await resend.sendAdminAlertEmail(`[ONBOARDING] ${toAlert.length} üye "bekliyor"da takılı`, {
          ozet: `${toAlert.length} ödemiş üye telefon sorusunu (Zap #2) tamamlamadığı için onboarding başlamadan takılı kaldı. Hiçbiri otomatik içerik almıyor.`,
          uyeler: lines,
          yapilmasi_gereken: 'İstersen bu üyeleri elle email akışına al (/admin/recover ile status=email) ya da Skool tarafında telefon sorusunu tekrar tetikle.'
        }).catch(e => log.error('[WATCHDOG] Admin alert failed', e));
        // Her raporlanan üyeye tek-seferlik marker → bir daha rapor edilmez
        for (const m of toAlert) {
          await notion.appendNote(m.id, '[WATCHDOG-ALERTED] "bekliyor"da takılı, admin bilgilendirildi.').catch(() => {});
        }
        log.warn(`[WATCHDOG] ${toAlert.length} takılı 'bekliyor' üyesi raporlandı`);
      } else {
        log.info(`[WATCHDOG] Takılı 'bekliyor' üyesi yok (taranan: ${stuck.length})`);
      }
    } catch (watchdogErr) {
      log.error(`[WATCHDOG] Sweep hatası: ${watchdogErr.message}`, watchdogErr.stack);
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
