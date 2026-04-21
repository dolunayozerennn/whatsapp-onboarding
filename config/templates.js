// ============================================================
// config/templates.js — ManyChat Flow ID Eşleştirmeleri
// ============================================================
// Her gün için bir ManyChat flow ID.
// Flow'lar ManyChat Builder'da oluşturulmuş olmalı.
// Her flow'un ilk adımı ilgili WhatsApp template mesajıdır.
// ============================================================

const ONBOARDING_FLOWS = {
  0: {
    flow_id: "content20260416192942_086852",
    template_name: "ai_factory_day_0",
    description: "Hoş geldin + Buradan Başla yönlendirmesi"
  },
  1: {
    flow_id: "content20260416193100_799326",
    template_name: "ai_factory_day_1",
    description: "Tarayıcıya ekle + mobil app + cliffhanger"
  },
  2: {
    flow_id: "content20260421135407_534387",
    template_name: "ai_factory_day_2",
    description: "Başarı hikayeleri"
  },
  3: {
    flow_id: "content20260421135530_976562",
    template_name: "ai_factory_day_3",
    description: "Platform turu: Classroom + Community + Mesajlar"
  },
  4: {
    flow_id: "content20260421135555_430815",
    template_name: "ai_factory_day_4",
    description: "Yıllık üyelik + JoinSecret"
  },
  5: {
    flow_id: "content20260421160009_655436",
    template_name: "ai_factory_day_5",
    description: "Takvim + etkinlikler"
  },
  6: {
    flow_id: "content20260421160043_896289",
    template_name: "ai_factory_day_6",
    description: "Affiliate programı + veda"
  }
};

// Field ID'leri — ManyChat custom fields
const CUSTOM_FIELDS = {
  onboarding_name: 14495722,
  whatsapp_phone_text: 14495740
};

module.exports = { ONBOARDING_FLOWS, CUSTOM_FIELDS };
