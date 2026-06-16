import type { Locale } from '../types'
import { en } from './en'
import type { Translations } from './types'

const localeLoaders: Record<Locale, () => Promise<Translations>> = {
  en: async () => en,
  es: () => import('./es').then(m => m.es),
  fr: () => import('./fr').then(m => m.fr),
  pl: () => import('./pl').then(m => m.pl),
  ru: () => import('./ru').then(m => m.ru),
  sv: () => import('./sv').then(m => m.sv),
  nl: () => import('./nl').then(m => m.nl),
  ja: () => import('./ja').then(m => m.ja),
}

const cache = new Map<Locale, Translations>()
cache.set('en', en)

export function getTranslations(locale: Locale): Translations {
  return cache.get(locale) ?? en
}

export async function loadTranslations(locale: Locale): Promise<Translations> {
  const cached = cache.get(locale)
  if (cached) return cached
  const translations = await localeLoaders[locale]()
  cache.set(locale, translations)
  return translations
}

export type { Translations }
