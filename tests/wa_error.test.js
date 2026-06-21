// ============================================================
// tests/wa_error.test.js — services/wa_error.js regresyon testi
// ============================================================
// BAĞIMSIZ DOĞRULAMA (Çıktı Nöbeti doktrini): bu testi düzeltmeyi
// YAZAN el yazmaz; ikinci bir göz "Bayram donması" fix'inin karar
// çekirdeğini düşmandan-bakışla doğrular.
//
// "Bayram donması" hatası: dual üyede WhatsApp gönderimi KALICI bir
// hata ile düşerse (tipli WA_ID_INVALID/WA_UNREACHABLE DEĞİL, ama
// jenerik bir sendFlow hatası içinde Meta 131xxx kodu ya da 4xx),
// email başarılı olsa bile üye "error"da donuyor, kalan onboarding
// günlerini kaybediyordu. Fix: kalıcı WA hatası + email gittiyse
// email-only'ye düşür, dondurma. GEÇİCİ WA hatası bu yola GİRMEMELİ
// (retry edilmeli).
//
// Sadece ../services/wa_error.js require edilir. Ağ yok, env yok,
// cron.js import edilmez.
// ============================================================

const assert = require('assert');
const { isPermanentError, shouldDemoteDualToEmail } = require('../services/wa_error');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed++;
    // console.log(`  ✓ ${label}`); // sessiz; sadece özet basılır
  } catch (e) {
    failed++;
    console.error(`  ✗ ${label}\n      ${e.message}`);
  }
}

// Gerçekçi hata fabrikaları ────────────────────────────────────
function err(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

// ManyChat'in jenerik sendFlow hatasının gerçek biçimi: typed code YOK,
// ama JSON.stringify'lı gövdede Meta 131xxx kodu var (Bayram vakası).
const genericPermSendFlow = err(
  'sendFlow hatası: {"status":"error","message":"recipient unavailable","code":131026}'
);

// ════════════════════════════════════════════════════════════════
// 1) isPermanentError — sınıflandırma
// ════════════════════════════════════════════════════════════════

// --- KALICI (true) ---
check('isPermanentError: WA_ID_INVALID → true', () => {
  assert.strictEqual(isPermanentError(err('no wa account', { code: 'WA_ID_INVALID' })), true);
});
check('isPermanentError: WA_UNREACHABLE → true', () => {
  assert.strictEqual(isPermanentError(err('blocked by meta', { code: 'WA_UNREACHABLE' })), true);
});
check('isPermanentError: jenerik 131026 JSON gövdeli sendFlow → true (Bayram)', () => {
  assert.strictEqual(isPermanentError(genericPermSendFlow), true);
});
check('isPermanentError: bare "code:131047" → true', () => {
  assert.strictEqual(isPermanentError(err('sendFlow hatası: code:131047')), true);
});
check('isPermanentError: parantezli (#131026) → true', () => {
  assert.strictEqual(isPermanentError(err('Message failed (#131026)')), true);
});
check('isPermanentError: 4xx status (400) → true', () => {
  assert.strictEqual(isPermanentError(err('bad request', { status: 400 })), true);
});
check('isPermanentError: 4xx status (404) → true', () => {
  assert.strictEqual(isPermanentError(err('not found', { statusCode: 404 })), true);
});
check('isPermanentError: "HTTP 4xx" mesajda → true', () => {
  assert.strictEqual(isPermanentError(err('upstream returned HTTP 422')), true);
});
check('isPermanentError: "invalid recipient" kalıbı → true', () => {
  assert.strictEqual(isPermanentError(err('invalid recipient phone')), true);
});

// --- GEÇİCİ (false) — retry edilmeli, DLQ/freeze DEĞİL ---
check('isPermanentError: 429 → false (geçici)', () => {
  assert.strictEqual(isPermanentError(err('too many requests', { status: 429 })), false);
});
check('isPermanentError: 503 → false (geçici)', () => {
  assert.strictEqual(isPermanentError(err('service unavailable', { status: 503 })), false);
});
check('isPermanentError: 500 → false (geçici)', () => {
  assert.strictEqual(isPermanentError(err('internal error', { statusCode: 500 })), false);
});
check('isPermanentError: AbortError/timeout → false (geçici)', () => {
  assert.strictEqual(isPermanentError(err('The operation was aborted', { name: 'AbortError' })), false);
});
check('isPermanentError: "timeout" mesajı → false (geçici)', () => {
  assert.strictEqual(isPermanentError(err('connection timeout after 8000ms')), false);
});
check('isPermanentError: ECONNRESET → false (geçici)', () => {
  assert.strictEqual(isPermanentError(err('read ECONNRESET')), false);
});

// --- Adversarial: GEÇİCİ guard, KALICI kalıptan ÖNCE çalışmalı ---
// Geçici status (429/5xx) mesajında kalıcı kalıp barındırsa bile GEÇİCİ kalmalı.
check('isPermanentError: 429 + mesajda "code:131026" → false (geçici öncelikli)', () => {
  assert.strictEqual(isPermanentError(err('rate limited code:131026', { status: 429 })), false);
});
check('isPermanentError: 503 + mesajda "HTTP 404" → false (geçici öncelikli)', () => {
  assert.strictEqual(isPermanentError(err('upstream said HTTP 404', { status: 503 })), false);
});

// --- Sınır durumları ---
check('isPermanentError: null → false', () => {
  assert.strictEqual(isPermanentError(null), false);
});
check('isPermanentError: undefined → false', () => {
  assert.strictEqual(isPermanentError(undefined), false);
});
check('isPermanentError: boş hata (mesaj/kod/status yok) → false', () => {
  assert.strictEqual(isPermanentError(err('')), false);
});
check('isPermanentError: masum metin (kod/status yok) → false', () => {
  assert.strictEqual(isPermanentError(err('beklenmeyen bir şey oldu ama ne olduğu belirsiz')), false);
});
// 13 + sadece 3 rakam (13xxx, 5 haneli) WA 131xxx serisi DEĞİL → eşleşmemeli.
check('isPermanentError: "code:13026" (5 haneli, 13\\d{4} değil) → false', () => {
  assert.strictEqual(isPermanentError(err('sendFlow hatası: code:13026')), false);
});

// ════════════════════════════════════════════════════════════════
// 2) shouldDemoteDualToEmail — dual escape gate karar tablosu
// ════════════════════════════════════════════════════════════════

// BAYRAM VAKASI: jenerik KALICI WA hatası (131026 gövdeli) + email gitti → demote=true
check('demote: BAYRAM — jenerik kalıcı WA (131026) + email ok → true', () => {
  assert.strictEqual(shouldDemoteDualToEmail(genericPermSendFlow, null, true), true);
});
// Tipli kalıcı kod da demote olmalı (eski yol da korunuyor mu)
check('demote: tipli WA_ID_INVALID + email ok → true', () => {
  assert.strictEqual(
    shouldDemoteDualToEmail(err('x', { code: 'WA_ID_INVALID' }), null, true),
    true
  );
});
// GEÇİCİ WA hatası + email ok → false (demote DEĞİL; retry-flag yoluna düşmeli, WA tekrar denenir)
check('demote: GEÇİCİ WA (timeout) + email ok → false (retry, demote DEĞİL)', () => {
  assert.strictEqual(shouldDemoteDualToEmail(err('connection timeout'), null, true), false);
});
check('demote: GEÇİCİ WA (429) + email ok → false', () => {
  assert.strictEqual(shouldDemoteDualToEmail(err('rate', { status: 429 }), null, true), false);
});
check('demote: GEÇİCİ WA (503) + email ok → false', () => {
  assert.strictEqual(shouldDemoteDualToEmail(err('down', { status: 503 }), null, true), false);
});
check('demote: GEÇİCİ WA (ECONNRESET) + email ok → false', () => {
  assert.strictEqual(shouldDemoteDualToEmail(err('read ECONNRESET'), null, true), false);
});
// KALICI WA ama email DE patladı → false (both-fail branşı ilgilenir, burada demote yok)
check('demote: kalıcı WA + email DE başarısız → false (both-fail yolu)', () => {
  assert.strictEqual(
    shouldDemoteDualToEmail(genericPermSendFlow, err('smtp 550'), false),
    false
  );
});
check('demote: kalıcı WA + email hatası (ama emailSentOk true gelse bile) → false', () => {
  // emailErr truthy ise emailSentOk değerine bakılmadan false dönmeli
  assert.strictEqual(
    shouldDemoteDualToEmail(genericPermSendFlow, err('smtp 550'), true),
    false
  );
});
// KALICI WA + email gönderilmedi (emailSentOk=false) → false (demote dayanağı yok)
check('demote: kalıcı WA + email gönderilmedi (emailSentOk=false) → false', () => {
  assert.strictEqual(shouldDemoteDualToEmail(genericPermSendFlow, null, false), false);
});
// WA başarılı (waErr yok) → false
check('demote: WA başarılı (waErr=null) → false', () => {
  assert.strictEqual(shouldDemoteDualToEmail(null, null, true), false);
});

// ════════════════════════════════════════════════════════════════
// ÖZET
// ════════════════════════════════════════════════════════════════
console.log('');
console.log(`Toplam: ${passed + failed} | PASS: ${passed} | FAIL: ${failed}`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
console.log('ALL PASS');
