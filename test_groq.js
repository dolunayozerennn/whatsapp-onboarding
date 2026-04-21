const { config } = require('./config/env');
async function test() {
  const cases = [
    "533 366 62 13",
    "0533 366 62 13",
    "+90 533 366 62 13",
    "numara vermek istemiyorum"
  ];
  
  const models = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile"
  ];

  const prompt = `Sen bir veri dönüştürme aracısın. Gelen metinden telefon numarasını çıkar ve SADECE JSON döndür.
JSON formatı:
{"valid": true, "normalized": "+905321234567", "reason": ""}
veya
{"valid": false, "normalized": null, "reason": "Numara yok"}

KURALLAR (KRİTİK):
1. Rakamların sırasını ASLA değiştirme. Girdiği gibi çıkar. Halüsinasyon yaparsan sistem çöker.
2. Sadece boşlukları ve tireleri temizle.
3. Numara '5' ile başlıyorsa ve toplam 10 rakamsa başa '+90' ekle.
4. Numara '05' ile başlıyorsa ve toplam 11 rakamsa başa '+9' ekle.
5. Kullanıcı sohbet veya itiraz ediyorsa valid: false döndür.`;

  for (const model of models) {
    console.log(`\n============================\nModel: ${model}\n============================`);
    for (const input of cases) {
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.groqApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: "system", content: prompt },
              { role: "user", content: input }
            ],
            max_tokens: 200,
            temperature: 0,
            response_format: { type: "json_object" }
          })
        });
        if (!response.ok) {
           console.log(`HTTP Error for ${model}: ${response.status} ${await response.text()}`);
           break;
        }
        const data = await response.json();
        console.log(`Input: "${input}" -> Output: ${data.choices[0].message.content.trim()}`);
      } catch (err) {
        console.log(`Err: ${err.message}`);
      }
    }
  }
}
test();
