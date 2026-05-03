// ============================================================
// utils/logger.js — Yapılandırılmış Loglama (ANA Standartları)
// ============================================================
// Enterprise Stabilization Doctrine: print(e) YASAK.
// Tüm loglar timestamp + seviye ile yazılır.
// Motor durumları takibi için obje/json desteği eklendi.
//
// Faz 4 P2 #19: Otomatik redaction layer.
// Loglara verilen meta objelerinde phone/email/token/secret alanları
// maskelenir. Recursive ama max derinlik = 3.
// ============================================================

const { maskPhone } = require('./phone');

const MAX_DEPTH = 3;

const PHONE_KEY_RE = /(phone|tel|numara)/i;
const EMAIL_KEY_RE = /(email|mail)/i;
const SECRET_KEY_RE = /(token|secret|password|apikey|api_key)/i;
// 'key' tek başına çok geniş kaçabilir; sadece sonu/başı 'key' olan ya da
// secret ile birlikte gelen alanları yakalamak için ayrı regex.
const KEY_KEY_RE = /(^|_)key$|^key($|_)|secretkey/i;

function maskEmail(value) {
  if (!value || typeof value !== 'string') return value;
  const at = value.indexOf('@');
  if (at < 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (local.length <= 2) return `${local}***${domain}`;
  return `${local.slice(0, 2)}***${domain}`;
}

function redactValue(key, value, depth) {
  // Anahtara göre redact
  if (typeof value === 'string' || typeof value === 'number') {
    if (SECRET_KEY_RE.test(key) || KEY_KEY_RE.test(key)) {
      return '[REDACTED]';
    }
    if (PHONE_KEY_RE.test(key)) {
      return maskPhone(String(value));
    }
    if (EMAIL_KEY_RE.test(key)) {
      return maskEmail(String(value));
    }
    return value;
  }
  // Nested obje/array — derinlik içinde recurse
  if (value && typeof value === 'object') {
    return redactDeep(value, depth + 1);
  }
  return value;
}

function redactDeep(input, depth = 0) {
  if (input === null || input === undefined) return input;
  if (depth > MAX_DEPTH) return '[Truncated:depth>' + MAX_DEPTH + ']';

  if (input instanceof Error) {
    return { message: input.message, name: input.name };
  }

  if (Array.isArray(input)) {
    return input.map((item) => {
      if (item && typeof item === 'object') return redactDeep(item, depth + 1);
      return item;
    });
  }

  if (typeof input === 'object') {
    const out = {};
    for (const k of Object.keys(input)) {
      try {
        out[k] = redactValue(k, input[k], depth);
      } catch (_) {
        out[k] = '[UnserializableValue]';
      }
    }
    return out;
  }

  return input;
}

function safeStringify(meta) {
  try {
    return JSON.stringify(redactDeep(meta));
  } catch (_) {
    // Circular ref vb. — sade string fallback
    return '[UnserializableMeta]';
  }
}

function formatTimestamp() {
  return new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
}

function formatMessage(level, msg, meta = null) {
  let output = `[${formatTimestamp()}] ${level}: ${msg}`;
  if (meta !== null && meta !== undefined) {
    output += `\n  ↳ META: ${safeStringify(meta)}`;
  }
  return output;
}

module.exports = {
  info: (msg, meta) => console.log(formatMessage('INFO', msg, meta)),
  warn: (msg, meta) => console.warn(formatMessage('WARN', msg, meta)),
  error: (msg, errorOrMeta) => {
    let meta = null;
    let stack = null;

    if (errorOrMeta instanceof Error) {
      stack = errorOrMeta.stack;
      meta = { message: errorOrMeta.message };
    } else if (typeof errorOrMeta === 'string') {
      stack = errorOrMeta;
    } else {
      meta = errorOrMeta;
    }

    console.error(formatMessage('ERROR', msg, meta));
    if (stack) console.error(stack);
  },
  debug: (msg, meta) => console.debug(formatMessage('DEBUG', msg, meta)),

  // Test/inspect amaçlı dışa açıyoruz (unit test'ten kullanılabilir)
  _redactDeep: redactDeep,
  _maskEmail: maskEmail
};
