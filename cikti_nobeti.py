"""
cikti_nobeti.py — WP Onboarding'in Çıktı Nöbeti sözleşmesi.

KARAR = "hangi üye → hangi gün → hangi onboarding flow → hangi kanal".
Yani her aktif üye için: bugün ne gönderilecek (gün N), hangi flow_id,
hangi kanal(lar) (whatsapp/email/dual), retry-only modunda mı, yoksa
skip/complete mi. Telefon doğrulama gibi YAN işler kapsam DIŞI — sadece
gün/flow/kanal seçimi.

Bu bir Node.js projesi. Gerçek karar fonksiyonu services/decision.js'teki
decide()'dır (cron.js de onu çağırır). Python burada subprocess ile
`node cikti_nobeti_bridge.js` çalıştırıp gerçek decide()'ı tetikler ve
JSON çıktısını parse eder. Karar mantığı Python'da YENİDEN YAZILMAZ.

OFFLINE garantisi:
  - replay() yalnızca bridge'i (--live OLMADAN) çağırır → bridge sadece
    services/decision.js + stdlib yükler, Notion/token YOK.
  - snapshot() canlı çekimi bridge --live ile yapar (token ister).
  - Bu modül top-level'da notion/token İÇE AKTARMAZ.

ZAMANA BAĞLILIK:
  - "bugün" (today) snapshot anında dondurulur ve input'a gömülür.
  - replay aynı dondurulmuş today'i kullanır → karar her gün AYNI çıkar,
    takvim ilerlese bile gürültü üretmez. Çıktıda daysDiff/tarih YOK,
    sadece ayrık karar (action/day/flow_id/channel).

Sözleşme: _skills/cikti-nobeti/nobet.py
"""
import json
import os
import subprocess

_HERE = os.path.dirname(os.path.abspath(__file__))
_BRIDGE = os.path.join(_HERE, "cikti_nobeti_bridge.js")

META = {
    "id": "wp-onboarding-gun-flow",
    "title": "WP Onboarding — gün/flow/kanal seçimi",
    "key": "key",
    "label": "key",
    "blast": "musteriye_gider",
}


def _run_bridge(args, stdin_data=None):
    """node cikti_nobeti_bridge.js çalıştır, stdout JSON'unu dön."""
    proc = subprocess.run(
        ["node", _BRIDGE] + args,
        cwd=_HERE,
        input=stdin_data,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"bridge exit {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return json.loads(proc.stdout)


def snapshot():
    """Canlı: Notion'dan aktif üyeleri çek, her biri için gerçek decide()'ı çalıştır.

    Bridge --live modunda Notion'u okur (token ister), dondurulabilir girdiyi
    (today + freeze edilmiş üye sinyalleri) ve karar çıktısını birlikte döner.
    """
    data = _run_bridge(["--live"])
    return {"input": data["input"], "output": data["output"]}


def replay(inp):
    """Offline: dondurulmuş {today, members} için AYNI decide()'ı çalıştır.

    Bridge'i --live OLMADAN çağırır → sadece services/decision.js yüklenir,
    token/Notion erişimi yok. Karar mantığı gerçek fonksiyondan gelir.
    """
    payload = json.dumps({"today": inp["today"], "members": inp["members"]})
    return _run_bridge([], stdin_data=payload)
