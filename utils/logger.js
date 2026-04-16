// ============================================================
// utils/logger.js — Yapılandırılmış Loglama
// ============================================================
// Enterprise Stabilization Doctrine: print(e) YASAK.
// Tüm loglar timestamp + seviye ile yazılır.
// ============================================================

function formatTimestamp() {
  return new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
}

function formatMessage(level, msg) {
  return `[${formatTimestamp()}] ${level}: ${msg}`;
}

module.exports = {
  info: (msg) => console.log(formatMessage('INFO', msg)),
  warn: (msg) => console.warn(formatMessage('WARN', msg)),
  error: (msg, stack) => {
    console.error(formatMessage('ERROR', msg));
    if (stack) console.error(stack);
  }
};
