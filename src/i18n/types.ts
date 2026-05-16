export type Locale = 'en' | 'es' | 'fr'

export const LOCALES: { code: Locale; label: string; short: string }[] = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'es', label: 'Español', short: 'ES' },
  { code: 'fr', label: 'Français', short: 'FR' },
]

export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_STORAGE_KEY = 'tscopier-locale'
