import i18next from 'i18next'
import ko from './ko.json' with { type: 'json' }
import en from './en.json' with { type: 'json' }

const initI18n = (locale = 'ko') => {
  i18next.init({
    lng: locale,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    showSupportNotice: false,
    resources: {
      ko: { translation: ko },
      en: { translation: en },
    },
  })
  return i18next
}

// t 함수 — 초기화 전에도 안전하게 사용 가능
const t = (key, opts) => i18next.isInitialized ? i18next.t(key, opts) : key

export { initI18n, t }
