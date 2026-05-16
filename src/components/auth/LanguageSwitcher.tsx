import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Globe } from 'lucide-react'
import clsx from 'clsx'
import { useLocale } from '../../context/LocaleContext'
import { LOCALES, type Locale } from '../../i18n/types'

interface LanguageSwitcherProps {
  className?: string
}

export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { locale, setLocale, auth } = useLocale()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const current = LOCALES.find(l => l.code === locale) ?? LOCALES[0]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (code: Locale) => {
    setLocale(code)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
          'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900',
          'dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50',
          open && 'bg-neutral-100 dark:bg-neutral-800',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={auth.language.choose}
        title={auth.language.label}
      >
        <Globe className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
        <span className="tabular-nums">{current.short}</span>
        <ChevronDown
          className={clsx('h-3.5 w-3.5 opacity-60 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label={auth.language.label}
          className={clsx(
            'absolute right-0 top-full z-50 mt-1.5 min-w-[10.5rem] overflow-hidden rounded-xl border py-1 shadow-lg',
            'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900',
          )}
        >
          {LOCALES.map(opt => (
            <li key={opt.code} role="option" aria-selected={locale === opt.code}>
              <button
                type="button"
                onClick={() => pick(opt.code)}
                className={clsx(
                  'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors',
                  locale === opt.code
                    ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-200'
                    : 'text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800',
                )}
              >
                <span>
                  <span className="font-medium">{opt.label}</span>
                  <span className="ml-1.5 text-xs text-neutral-400 dark:text-neutral-500">{opt.short}</span>
                </span>
                {locale === opt.code ? (
                  <Check className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
