import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import clsx from 'clsx'
import { useLocale } from '../../context/LocaleContext'
import { LocaleFlag } from '../ui/LocaleFlag'
import { filterLocales, LOCALES, type Locale } from '../../i18n/types'

interface LanguageSwitcherProps {
  className?: string
}

export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { locale, setLocale, auth } = useLocale()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listboxId = useId()

  const current = LOCALES.find(l => l.code === locale) ?? LOCALES[0]
  const filtered = useMemo(() => filterLocales(query), [query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(Math.max(0, filtered.length - 1))
    }
  }, [activeIndex, filtered.length])

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

  useEffect(() => {
    if (!open || !listRef.current) return
    const active = listRef.current.querySelector('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, filtered])

  const pick = (code: Locale) => {
    setLocale(code)
    setOpen(false)
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!filtered.length) return
      setActiveIndex(i => (i + 1) % filtered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!filtered.length) return
      setActiveIndex(i => (i - 1 + filtered.length) % filtered.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[activeIndex]
      if (opt) pick(opt.code)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  const activeOptionId = filtered[activeIndex]
    ? `${listboxId}-option-${filtered[activeIndex].code}`
    : undefined

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
        <LocaleFlag flagId={current.flagId} className="h-3 w-[1.125rem]" title={current.label} />
        <span className="tabular-nums">{current.short}</span>
        <ChevronDown
          className={clsx('h-3.5 w-3.5 opacity-60 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          className={clsx(
            'absolute right-0 top-full z-50 mt-1.5 w-[17rem] overflow-hidden rounded-xl border shadow-lg',
            'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900',
          )}
        >
          <div className="border-b border-neutral-100 p-2 dark:border-neutral-800">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" aria-hidden />
              <input
                ref={inputRef}
                type="search"
                value={query}
                role="combobox"
                aria-expanded
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={activeOptionId}
                placeholder={auth.language.searchPlaceholder}
                onChange={e => {
                  setQuery(e.target.value)
                  setActiveIndex(0)
                }}
                onKeyDown={onInputKeyDown}
                className={clsx(
                  'w-full rounded-lg border py-2 pl-8 pr-3 text-sm',
                  'border-neutral-200 bg-neutral-50 text-neutral-900 placeholder:text-neutral-400',
                  'focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500',
                  'dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100',
                )}
              />
            </div>
          </div>

          <ul
            id={listboxId}
            ref={listRef}
            role="listbox"
            aria-label={auth.language.label}
            className="max-h-[min(16rem,50vh)] overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
                {auth.language.noResults}
              </li>
            ) : (
              filtered.map((opt, idx) => {
                const isSelected = locale === opt.code
                const isActive = idx === activeIndex
                return (
                  <li
                    key={opt.code}
                    id={`${listboxId}-option-${opt.code}`}
                    role="option"
                    aria-selected={isSelected}
                    data-active={isActive ? 'true' : undefined}
                  >
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => pick(opt.code)}
                      className={clsx(
                        'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
                        isActive || isSelected
                          ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-200'
                          : 'text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800',
                      )}
                    >
                      <LocaleFlag flagId={opt.flagId} className="h-3.5 w-[1.3125rem]" />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{opt.label}</span>
                        <span className="ml-1.5 text-xs text-neutral-400 dark:text-neutral-500">{opt.short}</span>
                      </span>
                      {isSelected ? (
                        <Check className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                      ) : (
                        <span className="h-4 w-4 shrink-0" aria-hidden />
                      )}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
