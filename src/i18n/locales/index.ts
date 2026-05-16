import type { Locale } from '../types'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import type { Translations } from './types'

const byLocale: Record<Locale, Translations> = { en, es, fr }

export function getTranslations(locale: Locale): Translations {
  return byLocale[locale] ?? en
}

export type { Translations }
