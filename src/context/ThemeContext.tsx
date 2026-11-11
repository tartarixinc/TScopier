import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'tscopier-theme'

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  isDark: boolean
  /** When true, theme cannot be changed (e.g. marketing always light). */
  forced: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

export function applyThemeToDocument(theme: Theme) {
  const root = document.documentElement
  const isDark = theme === 'dark'
  root.classList.toggle('dark', isDark)
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

export function ThemeProvider({
  children,
  forcedTheme,
}: {
  children: ReactNode
  /** Pin the document to this theme and ignore storage / toggles. */
  forcedTheme?: Theme
}) {
  const [theme, setThemeState] = useState<Theme>(() => forcedTheme ?? readStoredTheme())

  useLayoutEffect(() => {
    const next = forcedTheme ?? theme
    applyThemeToDocument(next)
    if (!forcedTheme) localStorage.setItem(STORAGE_KEY, next)
  }, [theme, forcedTheme])

  const setTheme = useCallback(
    (next: Theme) => {
      if (forcedTheme) return
      setThemeState(next)
    },
    [forcedTheme],
  )

  const toggleTheme = useCallback(() => {
    if (forcedTheme) return
    setThemeState(prev => {
      const next = prev === 'dark' ? 'light' : 'dark'
      applyThemeToDocument(next)
      localStorage.setItem(STORAGE_KEY, next)
      return next
    })
  }, [forcedTheme])

  const resolved = forcedTheme ?? theme

  const value = useMemo(
    () => ({
      theme: resolved,
      setTheme,
      toggleTheme,
      isDark: resolved === 'dark',
      forced: Boolean(forcedTheme),
    }),
    [resolved, setTheme, toggleTheme, forcedTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
