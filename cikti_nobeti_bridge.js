// ============================================================
// cikti_nobeti_bridge.js — Çıktı Nöbeti JS köprüsü
// ============================================================
// Node projesi olduğu için karar GERÇEK fonksiyonu Node tarafında çalışır.
// Python (cikti_nobeti.py) bu script'i `node` ile çağırır, stdin'den
// {today, members:[...]} JSON'u verir, stdout'tan karar kayıtlarını okur.
//
// İki mod:
//   --live   : Notion'dan canlı üyeleri çek (snapshot için). Stdout'a
//              {input:{today,members}, output:[...]} yazar. Token ister.
//   (default): stdin'deki dondurulmuş {today, members} için kararı yeniden
//              hesaplar (replay için). Sadece services/decision.js + stdlib
//              kullanır — Notion/ManyChat/Resend YOK, offline.
//
// decide() GERÇEK karar fonksiyonudur (services/decision.js) — cron.js de
// aynısını çağırır. Burada mantık YENİDEN YAZILMAZ.
// ============================================================

const { decide } = require('./services/decision');

// Üyenin SADECE karar-girdisi alanlarını dondur (zamana-bağlı/PII olmayan
// karar sinyalleri). Telefon/email PII'sini freeze ETME — karar onlara
// içerik olarak bakmaz, sadece varlık/yokluk (phone) önemli olabilir; o yüzden
// hasPhone/hasEmail boolean'ı tutarız, ham PII'yi değil.
function freezeMember(m) {
  return {
    key: m.id || m.notionId || '',           // kayıt kimliği (Notion page id)
    onboardingStartDate: m.onboardingStartDate || '',
    onboardingStep: m.onboardingStep || 0,
    onboardingStatus: m.onboardingStatus || '',
    lastError: m.lastError || '',
    hasPhone: !!(m.phone && String(m.phone).trim()),
    hasEmail: !!(m.email && String(m.email).includes('@')),
  };
}

// Kanal seçimi üyenin onboardingStatus'una göre (cron.js hangi döngüye
// girdiğini buradan belirler: whatsapp | email | dual).
function channelFor(frozen) {
  const s = String(frozen.onboardingStatus || '').toLowerCase();
  if (s === 'dual') return 'dual';
  if (s === 'email') return 'email';
  return 'whatsapp';
}

// Bir dondurulmuş üye için ZAMANA-BAĞLI OLMAYAN karar kaydı üretir.
// today girdiden (dondurulmuş) gelir → her replay aynı sonucu verir.
function decideRow(frozen, today) {
  const channel = channelFor(frozen);
  const d = decide(
    {
      onboardingStartDate: frozen.onboardingStartDate,
      onboardingStep: frozen.onboardingStep,
      lastError: frozen.lastError,
      // dual WA gönderimi member.phone'a bakar; karar açısından sadece
      // varlık önemli (decision.js: decision.flow && member.phone).
      phone: frozen.hasPhone ? 'X' : '',
      email: frozen.hasEmail ? 'x@x' : '',
    },
    today,
    channel
  );
  // Karar kaydı: SADECE kararı temsil eden ayrık alanlar.
  // daysDiff/tarih GİBİ her gün değişen alan dönülmez (today dondurulmuş
  // girdiden geldiği için zaten sabit, ama yine de yalnızca kararı dönüyoruz).
  return {
    key: frozen.key,
    channel,
    action: d.action,
    reason: d.reason || null,
    day: d.day !== undefined ? d.day : null,
    channels: d.channels || null,
    retryOnly: d.retryOnly !== undefined ? d.retryOnly : null,
    flow_id: d.flow ? d.flow.flow_id : null,
  };
}

function rows(frozenMembers, today) {
  return frozenMembers.map(m => decideRow(m, today));
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function runLive() {
  // Canlı çekim — token ister. Lazy require: replay yolu bunu hiç çalıştırmaz.
  require('dotenv').config();
  const notion = require('./services/notion');
  const moment = require('moment-timezone');

  const today = moment.tz('Europe/Istanbul').startOf('day').format('YYYY-MM-DD');

  const wa = await notion.getActiveOnboardingMembers();
  const email = await notion.getActiveEmailMembers();
  const dual = await notion.getActiveDualMembers();
  const all = [...wa, ...email, ...dual];

  const frozen = all.map(freezeMember);
  const output = rows(frozen, today);
  process.stdout.write(JSON.stringify({ input: { today, members: frozen }, output }));
}

async function runReplay() {
  const raw = await readStdin();
  const inp = JSON.parse(raw);
  const output = rows(inp.members, inp.today);
  process.stdout.write(JSON.stringify(output));
}

(async () => {
  try {
    if (process.argv.includes('--live')) {
      await runLive();
    } else {
      await runReplay();
    }
  } catch (e) {
    process.stderr.write('BRIDGE_ERROR: ' + (e && e.stack ? e.stack : String(e)));
    process.exit(3);
  }
})();
