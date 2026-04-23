// ============================================================
// utils/logger.js — Yapılandırılmış Loglama (ANA Standartları)
// ============================================================
// Enterprise Stabilization Doctrine: print(e) YASAK.
// Tüm loglar timestamp + seviye ile yazılır.
// Motor durumları takibi için obje/json desteği eklendi.
// ============================================================

function formatTimestamp() {
  return new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
}

function formatMessage(level, msg, meta = null) {
  let output = \`[\${formatTimestamp()}] \${level}: \${msg}\`;
  if (meta) {
    output += \`\n  ↳ META: \${JSON.stringify(meta)}\`;
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
  debug: (msg, meta) => console.debug(formatMessage('DEBUG', msg, meta))
};
