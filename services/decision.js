// ============================================================
// services/decision.js — Onboarding karar çekirdeği (SAF fonksiyon)
// ============================================================
// "Hangi üye → hangi gün → hangi flow → hangi kanal" kararı.
//
// Bu modül SAF + yan-etkisizdir: Notion/ManyChat/Resend ÇAĞIRMAZ, log
// yazmaz, ağ kullanmaz. Sadece üyenin dondurulabilir alanları (onboarding
// başlangıç tarihi, mevcut adım, lastError) + "bugün" tarihinden hareketle
// hangi günün hangi flow'unun hangi kanaldan gönderilmesi gerektiğini söyler.
//
// cron.js bu kararı uygular (gönderme + Notion güncelleme yan-etkileri).
// Çıktı Nöbeti (cikti_nobeti.py) bu kararı dondurulmuş girdiye karşı
// yeniden çalıştırarak sessiz sapmayı yakalar.
//
// Tarih hesabı moment-timezone ile, üretimdeki cron ile BİREBİR aynı:
//   today = startOf('day', Europe/Istanbul)
//   startDay = parse(onboardingStartDate, 'YYYY-MM-DD', Europe/Istanbul)
//   daysDiff = today.diff(startDay, 'days')
// ============================================================

const moment = require('moment-timezone');
const { ONBOARDING_FLOWS } = require('../config/templates');

const TZ = 'Europe/Istanbul';
const MAX_DAY = 6;

// lastError üzerindeki dual-channel retry flag'ini çözer.
// Format: "wa-failed-day-N" | "email-failed-day-N"
function parseRetryFlag(lastError) {
  if (!lastError) return null;
  const m = String(lastError).match(/^(wa|email)-failed-day-(\d+)$/);
  if (!m) return null;
  return { channel: m[1], day: Number(m[2]) };
}

function flowFor(day) {
  const cfg = ONBOARDING_FLOWS[day];
  if (!cfg || !cfg.flow_id || String(cfg.flow_id).startsWith('TODO_')) return null;
  return { flow_id: cfg.flow_id, template_name: cfg.template_name };
}

// daysDiff hesabı — cron'daki ile birebir. todayStr verilirse onu "bugün"
// olarak kullanır (deterministik/test için); verilmezse gerçek bugünü alır.
function computeDaysDiff(onboardingStartDate, todayStr) {
  const today = (todayStr
    ? moment.tz(todayStr, 'YYYY-MM-DD', TZ)
    : moment.tz(TZ)).startOf('day');
  const startDay = moment.tz(onboardingStartDate, 'YYYY-MM-DD', TZ).startOf('day');
  if (!startDay.isValid()) {
    return { valid: false, daysDiff: null };
  }
  return { valid: true, daysDiff: today.diff(startDay, 'days') };
}

// ─── SAF KARAR ─────────────────────────────────────────────────
// channel: "whatsapp" | "email" | "dual" — hangi cron döngüsü.
// Dönüş: ZAMANA BAĞLI OLMAYAN bir karar nesnesi.
//   action: "invalid_date" | "skip_not_due" | "complete" | "send"
//   - send için: day, flows (gönderilecek günün flow'ları), channels
//     (denenecek kanal listesi), retryOnly (varsa)
// daysDiff/tarih gibi her gün değişen alanlar BİLEREK dönülmez — sadece
// üyenin onboarding mantığının VERDİĞİ karar dönülür.
function decide(member, todayStr, channel) {
  const { valid, daysDiff } = computeDaysDiff(member.onboardingStartDate, todayStr);

  if (!valid) {
    return { action: 'invalid_date' };
  }

  // Day 0 webhook'ta gönderildi; bugün/gelecek tarihli ise hiçbir şey gönderme.
  if (daysDiff < 1) {
    return { action: 'skip_not_due', reason: 'today_or_future' };
  }

  if (channel === 'dual') {
    // Atomic dual-channel: önceki cron'da bir kanal başarısızsa retry-only mode.
    const retryFlag = parseRetryFlag(member.lastError);
    let targetDay;
    let retryOnly = null; // "wa" | "email" | null

    if (retryFlag && retryFlag.day === member.onboardingStep + 1) {
      targetDay = retryFlag.day;
      retryOnly = retryFlag.channel;
    } else {
      if (daysDiff <= member.onboardingStep) {
        return { action: 'skip_not_due', reason: 'step_caught_up' };
      }
      targetDay = member.onboardingStep + 1;
    }

    if (targetDay > MAX_DAY) {
      return { action: 'complete' };
    }

    // Hangi kanallar denenecek (retry-only mode bunu daraltır).
    let channels;
    if (retryOnly === 'wa') channels = ['wa'];
    else if (retryOnly === 'email') channels = ['email'];
    else channels = ['wa', 'email'];

    return {
      action: 'send',
      day: targetDay,
      channels,
      retryOnly,
      flow: flowFor(targetDay), // wa kanalı için flow; yoksa null (WA atlanır)
    };
  }

  // whatsapp / email — tek kanal
  if (daysDiff <= member.onboardingStep) {
    return { action: 'skip_not_due', reason: 'step_caught_up' };
  }

  const expectedDay = member.onboardingStep + 1;

  if (expectedDay > MAX_DAY) {
    return { action: 'complete' };
  }

  if (channel === 'whatsapp') {
    const flow = flowFor(expectedDay);
    if (!flow) {
      return { action: 'flow_unconfigured', day: expectedDay };
    }
    return { action: 'send', day: expectedDay, channels: ['wa'], flow };
  }

  // email
  return { action: 'send', day: expectedDay, channels: ['email'], flow: null };
}

module.exports = { decide, parseRetryFlag, computeDaysDiff, flowFor };
