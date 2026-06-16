import type { Locale } from '../types'
import { authEn } from './en'
import type { AuthTranslations } from './types'
import { authEs } from './es'
import { authFr } from './fr'
import { authJa } from './ja'
import { authNl } from './nl'
import { authPl } from './pl'
import { authRu } from './ru'
import { authSv } from './sv'

const byLocale: Record<Locale, AuthTranslations> = {
  en: authEn,
  es: authEs,
  fr: authFr,
  pl: authPl,
  ru: authRu,
  sv: authSv,
  nl: authNl,
  ja: authJa,
}

export function getAuthTranslations(locale: Locale): AuthTranslations {
  return byLocale[locale] ?? authEn
}

export type { AuthTranslations }
