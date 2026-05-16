import type { Locale } from '../types'
import { authEn } from './en'
import type { AuthTranslations } from './types'
import { authEs } from './es'
import { authFr } from './fr'

const byLocale: Record<Locale, AuthTranslations> = {
  en: authEn,
  es: authEs,
  fr: authFr,
}

export function getAuthTranslations(locale: Locale): AuthTranslations {
  return byLocale[locale] ?? authEn
}

export type { AuthTranslations }
