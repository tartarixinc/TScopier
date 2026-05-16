import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { getTranslations, type Translations } from '../i18n/locales'
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  type Locale,
} from '../i18n/types'

function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (raw === 'en' || raw === 'es' || raw === 'fr') return raw
  } catch {
    /* private mode */
  }
  return DEFAULT_LOCALE
}

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translations
  /** @deprecated Use `t.auth` */
  auth: Translations['auth']
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale())

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const t = useMemo(() => getTranslations(locale), [locale])

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
      auth: t.auth,
    }),
    [locale, setLocale, t],
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider')
  return ctx
}

/** Shorthand for `useLocale().t` */
export function useT() {
  return useLocale().t
}
