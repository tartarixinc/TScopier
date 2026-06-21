import { createContext } from 'react'
import type { Translations } from '../i18n/locales'
import type { Locale } from '../i18n/types'

export interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translations
  /** @deprecated Use `t.auth` */
  auth: Translations['auth']
}

/** Separate module so Vite HMR does not replace the context object on provider edits. */
export const LocaleContext = createContext<LocaleContextValue | null>(null)
