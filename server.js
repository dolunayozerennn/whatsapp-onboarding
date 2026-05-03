// ============================================================
// server.js — WhatsApp Onboarding Express Server
// ============================================================
// Webhook endpoints + Health check + Cron initialization
//
// Endpoints:
//   POST /webhook/new-paid-member    — Zapier Zap #1
//   POST /webhook/membership-questions — Zapier Zap #2
//   POST /webhook/wa-optin           — ManyChat WhatsApp Opt-in (Hibrit Fallback)
//   POST /webhook/wa-confirmed       — ManyChat "Haydi baslayalim" butonu
//   POST /webhook/wa-undo            — ManyChat "Geri Al" butonu
//   POST /webhook/wa-failed          — ManyChat Fallback
//   GET  /health                     — Monitoring
// ============================================================

// 1. Fail-Fast: env doğrulama (boot time)
const { validateEnv, config } = require('./config/env');
validateEnv();

const express = require('express');
const app = express();
const moment = require('moment-timezone');

app.use(express.json());

const { ONBOARDING_FLOWS } = require('./config/templates');
const notion = require('./services/notion');
const manychat = require('./services/manychat');
const { validatePhone } = require('./services/phoneValidator');
const resend = require('./services/resend');
const log = require('./utils/logger');

// ─────────────────────────────────────────────────────────────
// In-Memory Lock — KISA SÜRELİ DEDUP (Zapier retry burst için 30s)
// ─────────────────────────────────────────────────────────────
// Source of truth artık Notion (transaction_id bazlı findByTransactionId).
// In-memory lock yalnızca aynı saniye içinde 5x retry'ı verimli yutmak için.
const processingLocks = new Map(); // key -> timestamp(ms)
const LOCK_TTL_MS = 30 * 1000;

function acquireLock(key) {
  const now = Date.now();
  // Eski lock'ları temizle
  const stamp = processingLocks.get(key);
  if (stamp && (now - stamp) < LOCK_TTL_MS) return false;
  processingLocks.set(key, now);
  return true;
}

function releaseLock(key) {
  processingLocks.delete(key);
}

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown — SIGTERM / SIGINT (P1 #11)
// ─────────────────────────────────────────────────────────────
let httpServer = null;
let shuttingDown = false;
// Cron tarafı bu flag'i okuyup iterasyonunu yarıda kesebilsin diye global
// bir kanal kullanıyoruz. cron.js bunu `globalThis.__SHUTTING_DOWN__` üzerinden okur.
globalThis.__SHUTTING_DOWN__ = false;

function initiateShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  globalThis.__SHUTTING_DOWN__ = true;
  log.warn(`[shutdown] ${signal} alındı — yeni istekler kabul edilmiyor, in-flight bekleniyor (max 10s)`);

  const forceTimer = setTimeout(() => {
    log.error('[shutdown] 10s timeout doldu, zorla çıkış');
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  if (httpServer) {
    httpServer.close((err) => {
      if (err) log.error(`[shutdown] server.close hatası: ${err.message}`);
      log.info('[shutdown] Server kapatıldı, çıkılıyor');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => initiateShutdown('SIGTERM'));
process.on('SIGINT', () => initiateShutdown('SIGINT'));

// ─────────────────────────────────────────────────────────────
// Security Middleware — Webhook & Admin Auth
// ─────────────────────────────────────────────────────────────
// WEBHOOK_SECRET artık zorunlu — config/env.js içindeki validateEnv()
// tarafından boot zamanı garantilendi. Bypass yok (fail-secure).
if (!process.env.ADMIN_SECRET) {
  log.warn('⚠️ ADMIN_SECRET tanımlı değil — admin auth DEVRE DIŞI. Production için tehlikeli!');
}
function webhookAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-webhook-secret'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token || token !== config.webhookSecret) {
    log.warn(`[security] Webhook auth başarısız — IP: ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function adminAuth(req, res, next) {
  if (!config.adminSecret) {
    log.warn('[security] ADMIN_SECRET tanımlı değil — auth atlanıyor');
    return next();
  }
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token !== config.adminSecret) {
    log.warn(`[security] Admin auth başarısız — IP: ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────
// Admin Rate Limit — Faz 4 P2 #21
// 10 req / 60s / IP. Sadece /admin/* için. Webhook ve /health hariç.
// ─────────────────────────────────────────────────────────────
const ADMIN_RL_WINDOW_MS = 60 * 1000;
const ADMIN_RL_MAX = 10;
const adminRateBuckets = new Map(); // ip -> { count, windowStart }

function adminRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = adminRateBuckets.get(ip);
  if (!bucket || (now - bucket.windowStart) > ADMIN_RL_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    adminRateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > ADMIN_RL_MAX) {
    log.warn(`[security] Admin rate limit aşıldı — IP: ${ip} (${bucket.count}/${ADMIN_RL_MAX})`);
    const retryAfter = Math.ceil((ADMIN_RL_WINDOW_MS - (now - bucket.windowStart)) / 1000);
    res.set('Retry-After', String(Math.max(retryAfter, 1)));
    return res.status(429).json({ error: 'Too Many Requests' });
  }
  next();
}

// Eski bucket'ları periyodik temizle (memory sızıntı önlemi)
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of adminRateBuckets) {
    if ((now - b.windowStart) > ADMIN_RL_WINDOW_MS * 2) adminRateBuckets.delete(ip);
  }
}, ADMIN_RL_WINDOW_MS).unref();

// ─────────────────────────────────────────────────────────────
// POST /webhook/new-paid-member — Zapier Zap #1
// ─────────────────────────────────────────────────────────────
app.post('/webhook/new-paid-member', webhookAuth, async (req, res) => {
  const { transaction_id, first_name, last_name, email, date } = req.body;

  log.info(`[new-paid-member] Gelen veri: ${JSON.stringify(req.body)}`);

  if (!transaction_id || !first_name) {
    log.warn('[new-paid-member] Eksik veri, atlanıyor');
    return res.status(400).json({ error: 'transaction_id ve first_name zorunlu' });
  }

  const lockKey = `tx_${transaction_id}`;
  // In-memory dedup yalnızca 30s'lik retry burst optimizasyonu — source of truth Notion.
  if (!acquireLock(lockKey)) {
    log.warn(`[new-paid-member] Aynı tx_id 30s içinde tekrar geldi (in-memory dedup): ${transaction_id}`);
    return res.status(200).json({ status: 'duplicate', source: 'in-memory' });
  }

  try {
    const cleanEmail = (email && email !== 'No data' && email.includes('@')) ? email : null;

    // Notion'da var mı kontrol et — Notion = source of truth
    const existing = await notion.findByTransactionId(transaction_id);

    // Idempotent erken-çıkış: kayıt zaten "tamamlandı" / "atlandı" ise hiçbir şey yapma
    if (existing && ['tamamlandı', 'atlandı'].includes(existing.onboardingStatus)) {
      log.info(`[new-paid-member] Idempotent skip (status=${existing.onboardingStatus}): ${transaction_id}`);
      return res.status(200).json({ status: 'duplicate', source: 'notion' });
    }

    if (existing) {
      const registrationDateValue = date || moment().tz('Europe/Istanbul').format('YYYY-MM-DD');
      const updates = {
        email: cleanEmail || null,
        lastName: last_name || null
      };
      // Kayit Tarihi sadece henuz yazilmamissa eklenir (Zap #2 once geldiyse bos olabilir)
      if (!existing.registrationDate) {
        updates.registrationDate = registrationDateValue;
      }

      let isRecovered = false;
      if (existing.onboardingStatus === 'error' && cleanEmail) {
        updates.onboardingStatus = 'email';
        updates.onboardingChannel = 'email';
        updates.onboardingStep = 0;
        // Faz 3 NEW (5am cutoff bug fix): startDate her zaman bugün (Istanbul).
        // Önceden hour<6 → dün rollback yapılıyordu; bu, cron noon'da daysDiff=1
        // olduğunda Day 0 webhook'tan + Day 1 cron'dan aynı gün gönderilmesine yol
        // açıyordu. Cron tarafındaki `daysDiff < 1` skip + WA loop'taki
        // `daysDiff <= step` skip aynı-gün korumasını zaten sağlıyor.
        updates.onboardingStartDate = moment().tz('Europe/Istanbul').format('YYYY-MM-DD');
        isRecovered = true;
      }

      await notion.updatePage(existing.id, updates);

      if (isRecovered) {
        await notion.appendNote(existing.id, '[FIX] Zap #1 geç geldi, email eklendi ve email onboarding başlatıldı.');
      }
      log.info(`[new-paid-member] Mevcut kayıt güncellendi: ${transaction_id}`);

      if (isRecovered) {
        await resend.sendOnboardingEmail(cleanEmail, first_name, 0);
        log.info(`[new-paid-member] Gün 0 email'i tetiklendi (Error kurtarıldı): ${cleanEmail}`);
      }
    } else {
      await notion.createMember({
        firstName: first_name,
        lastName: last_name || '',
        email: cleanEmail || '',
        transactionId: transaction_id,
        registrationDate: date || moment().tz('Europe/Istanbul').format('YYYY-MM-DD'),
        onboardingStatus: "bekliyor"
      });
      log.info(`[new-paid-member] Yeni kayıt: ${first_name} ${last_name} (${cleanEmail})`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    log.error(`[new-paid-member] HATA: ${error.message}`, error.stack);
    
    // Sistem Hatası E-postası (Sadece beklenmedik çökmelerde)
    await resend.sendAdminAlertEmail(`Webhook Hatası: new-paid-member`, {
      error: error.message,
      stack: error.stack,
      transaction_id: transaction_id
    }).catch(e => log.error('Admin alert failed', e));

    res.status(500).json({ error: error.message });
  } finally {
    releaseLock(lockKey);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /webhook/membership-questions — Zapier Zap #2
// ─────────────────────────────────────────────────────────────
app.post('/webhook/membership-questions', webhookAuth, async (req, res) => {
  const { transaction_id, first_name, last_name, answer_1, email, date } = req.body;

  log.info(`[membership-questions] Gelen veri: ${JSON.stringify(req.body)}`);

  if (!transaction_id) {
    log.warn('[membership-questions] transaction_id eksik, atlanıyor');
    return res.status(400).json({ error: 'transaction_id zorunlu' });
  }

  const phoneInput = (answer_1 || '').trim();
  if (!phoneInput) {
    log.info(`[membership-questions] answer_1 (telefon) boş bırakılmış, email fallback uygulanacak: ${transaction_id}`);
  }

  const lockKey = `tx_${transaction_id}`;
  if (!acquireLock(lockKey)) {
    log.warn(`[membership-questions] Aynı tx_id 30s içinde tekrar geldi (in-memory dedup): ${transaction_id}`);
    return res.status(200).json({ status: 'duplicate', source: 'in-memory' });
  }

  try {
    // 0. Eski üye kontrolü (E-mail veya İsim üzerinden)
    const cleanEmail = (email && email !== 'No data' && email.includes('@')) ? email : null;
    if (cleanEmail) {
      const existingByEmail = await notion.findByEmail(cleanEmail.trim());
      if (existingByEmail && existingByEmail.onboardingStatus === 'atlandı') {
        log.info(`[membership-questions] Eski üye atlanıyor (email eşleşmesi): ${cleanEmail}`);
        return res.status(200).json({ success: true, skipped: true, reason: 'eski_uye' });
      }
    } else {
      // İsim üzerinden eski üye eşleşmesi (findByName) kaldırıldı.
      // transaction_id ve email bazlı kontrol dedup için yeterli.
    }

    // 1. Telefon numarasını Groq LLM ile valide et
    let phoneResult;
    if (!phoneInput) {
      phoneResult = { valid: false, reason: "Numara girilmedi (Boş alan)", confidence: 0 };
    } else {
      phoneResult = await validatePhone(phoneInput);
    }
    log.info(`[membership-questions] Validasyon sonucu: ${JSON.stringify(phoneResult)}`);

    // 2. Notion'da kaydı bul.
    // Faz 3 P1 #15: Zapier Zap #2 bazen Zap #1'den önce ulaşıyor (sıra garantisi yok).
    // Doğrudan placeholder yaratmak yerine 3 retry × 2s ile new-paid-member'ı bekle.
    // Toplam ~6s; webhook timeout (Zapier 30s) bunun çok üstünde, güvenli.
    let member = await notion.findByTransactionId(transaction_id);
    let raceRetried = false;
    if (!member) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        member = await notion.findByTransactionId(transaction_id);
        if (member) {
          log.info(`[membership-questions] Race retry başarılı (deneme ${attempt}/3): ${transaction_id}`);
          raceRetried = true;
          break;
        }
        log.info(`[membership-questions] Race retry deneme ${attempt}/3 boş döndü: ${transaction_id}`);
      }
    }

    if (!member) {
      // 6s sonra hala yok — placeholder yarat ama observability için açıkça flagle.
      if (!cleanEmail) {
        member = await notion.createMember({
          firstName: first_name,
          lastName: last_name || '',
          transactionId: transaction_id,
          registrationDate: date || moment().tz('Europe/Istanbul').format('YYYY-MM-DD'),
          onboardingStatus: "error"
        });
        await notion.appendNote(member.id, "[HATA] membership-questions arrived before new-paid-member (3×2s retry sonrası bulunamadı), email yok.");
        log.warn(`[membership-questions] Yeni kayıt "error" statüsünde oluşturuldu (Race + Email eksik)`);

        await resend.sendAdminAlertEmail(`Zombie Üye Tespit Edildi (Zap #2)`, {
          error: "Yeni üye Zap #2 (membership-questions) ile oluşturulmaya çalışıldı, 3×2s race retry sonrası new-paid-member yok ve email adresi yok. Onboarding askıya alındı.",
          transaction_id: transaction_id,
          first_name: first_name
        }).catch(e => log.error('Admin alert failed', e));
      } else {
        member = await notion.createMember({
          firstName: first_name,
          lastName: last_name || '',
          email: cleanEmail,
          transactionId: transaction_id,
          registrationDate: date || moment().tz('Europe/Istanbul').format('YYYY-MM-DD'),
          onboardingStatus: "bekliyor"
        });
        await notion.appendNote(member.id, "membership-questions arrived before new-paid-member (3×2s retry sonrası bulunamadı, email mevcut)");
        log.info(`[membership-questions] Kayıt oluşturuldu (new-paid-member yok, race retry exhausted)`);
      }
    } else if (raceRetried) {
      await notion.appendNote(member.id, "[RACE] membership-questions Zap #1'den önce geldi, retry ile yakalandı");
    }

    // 3. Deduplication kontrolü
    const skipStatuses = ['whatsapp', 'email', 'dual', 'tamamlandı', 'error'];
    if (skipStatuses.includes(member.onboardingStatus)) {
      log.info(`[membership-questions] Zaten onboarding'de veya tamamlanmış, atlanıyor: ${transaction_id}`);
      return res.status(200).json({ success: true, skipped: true });
    }

    if (phoneResult.valid && phoneResult.confidence >= 0.5) {
      // 4a. Telefon numarası ile deduplication
      const existingPhone = await notion.findByPhone(phoneResult.normalized);
      if (existingPhone && existingPhone.id !== member.id) {
        if (['tamamlandı', 'error', 'atlandı'].includes(existingPhone.onboardingStatus)) {
          log.info(`[DEDUP] ${existingPhone.firstName} tekrar abone, telefon deduplication atlanıyor, yeni onboarding başlatılıyor`);
        } else {
          log.warn(`[membership-questions] Bu numara başka aktif hesapta kayıtlı: ${phoneResult.normalized}`);
          await notion.updatePage(member.id, {
            onboardingStatus: "atlandı"
          });
          await notion.appendNote(member.id, `Telefon ${phoneResult.normalized} başka aktif hesapta mevcut — dedup`);
          return res.status(200).json({ success: true, skipped: true });
        }
      }

      // 5. ManyChat'te subscriber oluştur + Gün 0 flow'unu tetikle
      await manychat.ensureSubscriberAndSendFlow(
        phoneResult.normalized,
        first_name,
        ONBOARDING_FLOWS[0].flow_id
      );

      // 6. Notion'ı güncelle.
      // Faz 3 NEW (5am cutoff bug fix): startDate her zaman bugün (Istanbul).
      // Önceki hour<6 rollback aynı gün Day 0 + Day 1 gönderilmesine yol açıyordu.
      const startDateWa = moment().tz('Europe/Istanbul').format('YYYY-MM-DD');
      
      const memberCleanEmail = (member.email && member.email !== 'No data' && member.email.includes('@')) ? member.email : null;
      
      if (memberCleanEmail) {
        await notion.updatePage(member.id, {
          phone: phoneResult.normalized,
          onboardingStatus: "dual",
          onboardingChannel: "dual",
          onboardingStep: 0,
          onboardingStartDate: startDateWa
        });
        
        await resend.sendOnboardingEmail(memberCleanEmail, first_name, 0);
        log.info(`[membership-questions] Dual onboarding baslatildi: ${first_name} WA + Email`);
      } else {
        await notion.updatePage(member.id, {
          phone: phoneResult.normalized,
          onboardingStatus: "whatsapp",
          onboardingChannel: "whatsapp",
          onboardingStep: 0,
          onboardingStartDate: startDateWa
        });

        log.info(`[membership-questions] Sadece WA onboarding (email yok): ${first_name}`);
      }

    } else {
      // 4b. Geçersiz numara veya Düşük Güven Skoru → Email fallback
      const failReason = !phoneResult.valid ? phoneResult.reason : "Düşük güven skoru";
      const confidenceStr = phoneResult.confidence !== undefined ? phoneResult.confidence : 'N/A';
      
      // Faz 3 NEW (5am cutoff bug fix): startDate her zaman bugün (Istanbul).
      const startDateEmail = moment().tz('Europe/Istanbul').format('YYYY-MM-DD');

      // 5. Email fallback'e düşmeden önce email kontrolü yap
      const memberCleanEmail = (member.email && member.email !== 'No data' && member.email.includes('@')) ? member.email : null;

      if (!memberCleanEmail) {
        await notion.updatePage(member.id, {
          onboardingStatus: "error"
        });
        await notion.appendNote(member.id, `Telefon geçersiz (${failReason}) ve geçerli email adresi yok. Sistemde tıkandı.`);
        log.warn(`[membership-questions] Sessiz Kayıp Engellendi: Email fallback'e düşüldü ama email yok (status: error)`);
        
        await resend.sendAdminAlertEmail(`Zombie Üye Tespit Edildi (Email Fallback)`, {
          error: `Telefon cevabı geçersiz (${failReason}), fallback yapılacak ancak email adresi yok.`,
          transaction_id: transaction_id,
          first_name: first_name
        }).catch(e => log.error('Admin alert failed', e));
      } else {
        await resend.sendOnboardingEmail(memberCleanEmail, first_name, 0);

        // 6. Notion'ı güncelle
        await notion.updatePage(member.id, {
          onboardingStatus: "email",
          onboardingChannel: "email",
          onboardingStep: 0,
          onboardingStartDate: startDateEmail
        });
        await notion.appendNote(member.id, `Telefon cevabı: "${answer_1}" — Sebep: ${failReason} (Güven: ${confidenceStr})`);

        log.info(`[membership-questions] Email fallback: ${first_name} — ${phoneResult.reason}`);
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    log.error(`[membership-questions] HATA: ${error.message}`, error.stack);
    
    await resend.sendAdminAlertEmail(`Webhook Hatası: membership-questions`, {
      error: error.message,
      stack: error.stack,
      transaction_id: transaction_id
    }).catch(e => log.error('Admin alert failed', e));

    res.status(500).json({ error: error.message });
  } finally {
    releaseLock(lockKey);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /webhook/wa-optin — ManyChat WhatsApp Opt-in (Hibrit Fallback)
// ─────────────────────────────────────────────────────────────
app.post('/webhook/wa-optin', webhookAuth, async (req, res) => {
  const { phone: rawPhone, first_name } = req.body;
  const phone = rawPhone ? rawPhone.replace(/^\+/, '') : null;
  const phoneWithPlus = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : null;

  log.info(`[wa-optin] Gelen veri: ${JSON.stringify(req.body)}`);

  if (!phone) {
    log.warn('[wa-optin] phone eksik, atlanıyor');
    return res.status(400).json({ error: 'phone zorunlu' });
  }

  const lockKey = `phone_${phone}`;
  if (!acquireLock(lockKey)) {
    log.warn(`[wa-optin] Race condition engellendi: ${phone}`);
    return res.status(429).json({ error: 'Şu an işleniyor, lütfen daha sonra tekrar deneyin.' });
  }

  try {
    let member = await notion.findByPhone(phoneWithPlus);
    if (!member) {
      member = await notion.findByPhone(phone);
    }
    if (!member) {
      log.warn(`[wa-optin] Notion'da kullanıcı bulunamadı: ${phone}`);
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    if (member.onboardingStatus !== 'email') {
      log.info(`[wa-optin] Statü "email" değil (${member.onboardingStatus}), atlanıyor: ${phone}`);
      return res.status(200).json({ success: true, skipped: true, reason: `Statü: ${member.onboardingStatus}` });
    }

    const newNote = `[WA-OPTIN] Kullanıcı email'den WhatsApp'a geçiş yaptı — ${new Date().toISOString()}`;
    const currentStep = member.onboardingStep || 0;

    if (currentStep >= 6) {
      await notion.updatePage(member.id, {
        onboardingStatus: "tamamlandı",
        onboardingChannel: "whatsapp"
      });
      await notion.appendNote(member.id, newNote);
      log.info(`[wa-optin] Step >= 6, onboarding tamamlandı olarak işaretlendi: ${member.firstName} (${phone})`);
    } else {
      const nextStep = currentStep + 1;
      const nextFlow = ONBOARDING_FLOWS[nextStep];

      if (nextFlow && nextFlow.flow_id) {
        await manychat.ensureSubscriberAndSendFlow(
          phone,
          first_name || member.firstName,
          nextFlow.flow_id
        );
        log.info(`[wa-optin] ManyChat flow tetiklendi: Step ${nextStep} → ${nextFlow.flow_id}`);
      }

      await notion.updatePage(member.id, {
        onboardingStatus: "whatsapp",
        onboardingChannel: "whatsapp",
        onboardingStep: nextStep
      });
      await notion.appendNote(member.id, newNote);
      log.info(`[wa-optin] Email'den WhatsApp'a geçiş tamamlandı: ${member.firstName} (${phone}), Step: ${currentStep} → ${nextStep}`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    log.error(`[wa-optin] HATA: ${error.message}`, error.stack);
    
    await resend.sendAdminAlertEmail(`Webhook Hatası: wa-optin`, {
      error: error.message,
      stack: error.stack,
      phone: phone
    }).catch(e => log.error('Admin alert failed', e));

    res.status(500).json({ error: error.message });
  } finally {
    releaseLock(lockKey);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /webhook/wa-confirmed — ManyChat "Haydi baslayalim" butonu
// ─────────────────────────────────────────────────────────────
app.post('/webhook/wa-confirmed', webhookAuth, async (req, res) => {
  const { phone: rawPhone, first_name } = req.body;
  const phone = rawPhone ? rawPhone.replace(/^\+/, '') : null;
  const phoneWithPlus = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : null;

  log.info(`[wa-confirmed] Gelen veri: ${JSON.stringify(req.body)}`);

  if (!phone) {
    log.warn('[wa-confirmed] phone eksik, atlanıyor');
    return res.status(400).json({ error: 'phone zorunlu' });
  }

  const lockKey = `phone_${phone}`;
  if (!acquireLock(lockKey)) {
    log.warn(`[wa-confirmed] Race condition engellendi: ${phone}`);
    return res.status(429).json({ error: 'Şu an işleniyor, lütfen daha sonra tekrar deneyin.' });
  }

  try {
    let member = await notion.findByPhone(phoneWithPlus);
    if (!member) {
      member = await notion.findByPhone(phone);
    }
    if (!member) {
      log.warn(`[wa-confirmed] Notion'da kullanıcı bulunamadı: ${phone}`);
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    if (member.onboardingStatus === 'dual') {
      await notion.updatePage(member.id, {
        onboardingStatus: "whatsapp",
        onboardingChannel: "whatsapp"
      });
      await notion.appendNote(member.id, "[WA-CONFIRMED] Kullanici WhatsApp'i tercih etti, email durduruldu");
      log.info(`[wa-confirmed] Dual moddan WA'ya geçildi: ${first_name} (${phone})`);
    } else {
      log.info(`[wa-confirmed] Zaten ${member.onboardingStatus} durumunda, atlanıyor: ${phone}`);
      return res.status(200).json({ success: true, skipped: true });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    log.error(`[wa-confirmed] HATA: ${error.message}`, error.stack);
    
    await resend.sendAdminAlertEmail(`Webhook Hatası: wa-confirmed`, {
      error: error.message,
      stack: error.stack,
      phone: phone
    }).catch(e => log.error('Admin alert failed', e));

    res.status(500).json({ error: error.message });
  } finally {
    releaseLock(lockKey);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /webhook/wa-undo — ManyChat "Geri Al" butonu
// ─────────────────────────────────────────────────────────────
app.post('/webhook/wa-undo', webhookAuth, async (req, res) => {
  const { phone: rawPhone, first_name } = req.body;
  const phone = rawPhone ? rawPhone.replace(/^\+/, '') : null;
  const phoneWithPlus = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : null;

  log.info(`[wa-undo] Gelen veri: ${JSON.stringify(req.body)}`);

  if (!phone) {
    log.warn('[wa-undo] phone eksik, atlanıyor');
    return res.status(400).json({ error: 'phone zorunlu' });
  }

  const lockKey = `phone_${phone}`;
  if (!acquireLock(lockKey)) {
    log.warn(`[wa-undo] Race condition engellendi: ${phone}`);
    return res.status(429).json({ error: 'Şu an işleniyor, lütfen daha sonra tekrar deneyin.' });
  }

  try {
    let member = await notion.findByPhone(phoneWithPlus);
    if (!member) {
      member = await notion.findByPhone(phone);
    }
    if (!member) {
      log.warn(`[wa-undo] Notion'da kullanıcı bulunamadı: ${phone}`);
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    if (member.onboardingStatus === 'email') {
      if (!member.phone) {
        log.warn(`[wa-undo] Email durumunda ama telefon numarası yok, atlanıyor: ${phone}`);
        return res.status(200).json({ success: true, skipped: true, reason: 'telefon_yok' });
      }
      
      await notion.updatePage(member.id, {
        onboardingStatus: "whatsapp",
        onboardingChannel: "whatsapp"
      });
      await notion.appendNote(member.id, "[WA-UNDO] Geri al tiklandi, WhatsApp'a donuldu, email durduruldu");
      log.info(`[wa-undo] Geri al işlemi yapıldı, WhatsApp'a geçildi: ${first_name} (${phone})`);
    } else {
      log.info(`[wa-undo] ${member.onboardingStatus} durumundan geri al yapilamiyor, atlanıyor: ${phone}`);
      return res.status(200).json({ success: true, skipped: true, reason: `statü: ${member.onboardingStatus}` });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    log.error(`[wa-undo] HATA: ${error.message}`, error.stack);
    
    await resend.sendAdminAlertEmail(`Webhook Hatası: wa-undo`, {
      error: error.message,
      stack: error.stack,
      phone: phone
    }).catch(e => log.error('Admin alert failed', e));

    res.status(500).json({ error: error.message });
  } finally {
    releaseLock(lockKey);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /webhook/wa-failed — ManyChat Fallback
// ─────────────────────────────────────────────────────────────
app.post('/webhook/wa-failed', webhookAuth, async (req, res) => {
  const { phone: rawPhone, reason } = req.body;
  const phone = rawPhone ? rawPhone.replace(/^\+/, '') : null;
  const phoneWithPlus = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : null;

  log.info(`[wa-failed] Gelen veri: ${JSON.stringify(req.body)}`);

  if (!phone) {
    log.warn('[wa-failed] phone eksik, atlanıyor');
    return res.status(400).json({ error: 'phone zorunlu' });
  }

  const lockKey = `phone_${phone}`;
  if (!acquireLock(lockKey)) {
    log.warn(`[wa-failed] Race condition engellendi: ${phone}`);
    return res.status(429).json({ error: 'Şu an işleniyor, lütfen daha sonra tekrar deneyin.' });
  }

  try {
    let member = await notion.findByPhone(phoneWithPlus);
    if (!member) {
      member = await notion.findByPhone(phone);
    }
    if (!member) {
      log.warn(`[wa-failed] Notion'da kullanıcı bulunamadı: ${phone}`);
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    const newNote = `[WA-FAILED] Sebep: ${reason || 'Bilinmiyor'} — Email'e yönlendirildi.`;

    await notion.updatePage(member.id, {
      onboardingStatus: "email",
      onboardingChannel: "email"
    });
    await notion.appendNote(member.id, newNote);

    log.info(`[wa-failed] Notion güncellendi, email kanalına alındı: ${member.firstName} (${phone})`);

    const memberCleanEmail = (member.email && member.email !== 'No data' && member.email.includes('@')) ? member.email : null;

    if (memberCleanEmail) {
      try {
        await resend.sendHybridFallbackEmail(memberCleanEmail, member.firstName, member.onboardingStep || 0, config.waBusinessPhone);
        log.info(`[wa-failed] Hibrit fallback email tetiklendi: ${memberCleanEmail}`);
      } catch (emailErr) {
        log.error(`[wa-failed] Email gönderme hatası: ${emailErr.message}`, emailErr.stack);
      }
    } else {
      log.warn(`[wa-failed] Kullanıcının geçerli emaili yok, email atılamadı: ${member.firstName}`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    log.error(`[wa-failed] HATA: ${error.message}`, error.stack);
    
    await resend.sendAdminAlertEmail(`Webhook Hatası: wa-failed`, {
      error: error.message,
      stack: error.stack,
      phone: phone
    }).catch(e => log.error('Admin alert failed', e));

    res.status(500).json({ error: error.message });
  } finally {
    releaseLock(lockKey);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /admin/trigger-flow — Manuel ManyChat Flow Tetikleme
// ─────────────────────────────────────────────────────────────
app.post('/admin/trigger-flow', adminRateLimit, adminAuth, async (req, res) => {
  try {
    const { phone, first_name, flow_step } = req.body;

    log.info(`[admin/trigger-flow] Gelen istek: ${JSON.stringify(req.body)}`);

    if (!phone || !first_name) {
      return res.status(400).json({ error: 'phone ve first_name zorunlu' });
    }

    const step = flow_step !== undefined ? flow_step : 0;
    const flowConfig = ONBOARDING_FLOWS[step];

    if (!flowConfig || !flowConfig.flow_id) {
      return res.status(400).json({ error: `Geçersiz flow_step: ${step}` });
    }

    const subscriberId = await manychat.ensureSubscriberAndSendFlow(
      phone,
      first_name,
      flowConfig.flow_id
    );

    log.info(`[admin/trigger-flow] ✅ Başarılı: ${first_name} → Step ${step} (${flowConfig.description})`);

    res.status(200).json({
      success: true,
      subscriberId,
      flow: {
        step,
        flow_id: flowConfig.flow_id,
        description: flowConfig.description
      }
    });
  } catch (error) {
    log.error(`[admin/trigger-flow] HATA: ${error.message}`, error.stack);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/get-user — Geçici Kullanıcı Arama
// ─────────────────────────────────────────────────────────────
app.get('/admin/get-user', adminRateLimit, adminAuth, async (req, res) => {
  try {
    const { Client } = require('@notionhq/client');
    const notionClient = new Client({ auth: config.notionApiKey });
    const response = await notionClient.databases.query({
      database_id: config.notionDatabaseId,
      sorts: [
        {
          timestamp: "created_time",
          direction: "descending"
        }
      ],
      page_size: 10
    });
    
    const users = response.results.map(page => ({
      id: page.id,
      isim: page.properties["İsim"]?.title?.[0]?.text?.content,
      soyisim: page.properties["Soyisim"]?.rich_text?.[0]?.text?.content,
      telefon: page.properties["Telefon"]?.phone_number,
      email: page.properties["Email"]?.email,
      skoolId: page.properties["Skool ID"]?.rich_text?.[0]?.text?.content,
      status: page.properties["Onboarding Durumu"]?.select?.name,
      notes: page.properties["Notlar"]?.rich_text?.[0]?.text?.content
    }));
    
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const members = await notion.getActiveOnboardingMembers();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      timezone: config.cronTimezone,
      activeOnboardings: members.length,
      services: {
        notion: 'connected',
        groq: config.groqApiKey ? 'configured' : 'missing',
        manychat: config.manychatApiToken ? 'configured' : 'missing',
        resend: config.resendApiKey ? 'configured' : 'not_configured'
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Boot-Time Validations: ManyChat flows + Notion şema drift
// ─────────────────────────────────────────────────────────────
async function runBootValidations() {
  // 1) ManyChat flow ID'leri
  try {
    const flowIds = Object.values(ONBOARDING_FLOWS)
      .map(f => f.flow_id)
      .filter(id => id && !id.startsWith('TODO_'));
    await manychat.validateAllFlows(flowIds);
  } catch (err) {
    console.error('❌ FATAL: ManyChat flow validasyonu başarısız');
    console.error(err.message);
    try {
      await resend.sendAdminAlertEmail('[BOOT] ManyChat flow validasyonu başarısız', {
        error: err.message,
        stack: err.stack
      });
    } catch (_) { /* alert gönderilemese bile boot'u durdur */ }
    process.exit(1);
  }

  // 2) Notion şema drift kontrolü
  try {
    await notion.validateSchema();
  } catch (err) {
    console.error('❌ FATAL: Notion şema drift tespit edildi');
    console.error(err.message);
    try {
      await resend.sendAdminAlertEmail('[BOOT] Notion şema drift', {
        error: err.message,
        stack: err.stack
      });
    } catch (_) { /* alert gönderilemese bile boot'u durdur */ }
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// Cron job'ları başlat
// ─────────────────────────────────────────────────────────────
require('./cron');

// ─────────────────────────────────────────────────────────────
// Server başlat
// ─────────────────────────────────────────────────────────────
const PORT = config.port;
httpServer = app.listen(PORT, '0.0.0.0', async () => {
  await runBootValidations();
  log.info(`WhatsApp Onboarding server başlatıldı: 0.0.0.0:${PORT}`);
  log.info(`Webhook URL'ler:`);
  log.info(`  POST /webhook/new-paid-member`);
  log.info(`  POST /webhook/membership-questions`);
  log.info(`  POST /webhook/wa-optin`);
  log.info(`  POST /webhook/wa-confirmed`);
  log.info(`  POST /webhook/wa-undo`);
  log.info(`  POST /webhook/wa-failed`);
  log.info(`  POST /admin/trigger-flow`);
  log.info(`  GET  /admin/get-user`);
  log.info(`  GET  /health`);
});
