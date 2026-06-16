export type Locale = 'en' | 'es' | 'fr' | 'pl' | 'ru' | 'sv' | 'nl' | 'ja'

export type LocaleOption = {
  code: Locale
  label: string
  short: string
  /** ISO 3166-1 alpha-2 id in `public/flags.svg` (country flag, not language code). */
  flagId: string
  searchText: string
}

const LOCALE_CODES: readonly Locale[] = [
  'en', 'es', 'fr', 'pl', 'ru', 'sv', 'nl', 'ja',
] as const

export function isLocale(value: string | null | undefined): value is Locale {
  return LOCALE_CODES.includes(value as Locale)
}

export const LOCALES: LocaleOption[] = [
  {
    code: 'en',
    label: 'English',
    short: 'EN',
    flagId: 'gb',
    searchText: 'english en british uk united kingdom',
  },
  {
    code: 'es',
    label: 'Español',
    short: 'ES',
    flagId: 'es',
    searchText: 'spanish espanol españa spain',
  },
  {
    code: 'fr',
    label: 'Français',
    short: 'FR',
    flagId: 'fr',
    searchText: 'french francais france',
  },
  {
    code: 'pl',
    label: 'Polski',
    short: 'PL',
    flagId: 'pl',
    searchText: 'polish polski poland polska',
  },
  {
    code: 'ru',
    label: 'Русский',
    short: 'RU',
    flagId: 'ru',
    searchText: 'russian russkiy russia',
  },
  {
    code: 'sv',
    label: 'Svenska',
    short: 'SV',
    flagId: 'se',
    searchText: 'swedish svenska sweden',
  },
  {
    code: 'nl',
    label: 'Nederlands',
    short: 'NL',
    flagId: 'nl',
    searchText: 'dutch nederlands netherlands holland',
  },
  {
    code: 'ja',
    label: '日本語',
    short: 'JA',
    flagId: 'jp',
    searchText: 'japanese nihongo japan jap',
  },
]

export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_STORAGE_KEY = 'tscopier-locale'

/** Case- and diacritic-insensitive substring match for language picker search. */
export function normalizeLocaleSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

export function filterLocales(query: string, locales: readonly LocaleOption[] = LOCALES): LocaleOption[] {
  const normalized = normalizeLocaleSearchText(query)
  if (!normalized) return [...locales]
  return locales.filter(opt => {
    const haystack = normalizeLocaleSearchText(
      `${opt.label} ${opt.short} ${opt.code} ${opt.searchText}`,
    )
    return haystack.includes(normalized)
  })
}
