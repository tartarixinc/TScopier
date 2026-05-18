import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import clsx from 'clsx'

export interface SearchableSelectOption {
  value: string
  label: string
}

interface SearchableSelectProps {
  label?: string
  value: string
  onChange: (value: string) => void
  options: SearchableSelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  noMatchesLabel?: string
  required?: boolean
  error?: string
  className?: string
}

export function SearchableSelect({
  label,
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  noMatchesLabel = 'No matches',
  required,
  error,
  className,
}: SearchableSelectProps) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = useMemo(
    () => options.find(o => o.value === value),
    [options, value],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    )
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => searchRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
    setQuery('')
  }, [open])

  return (
    <div ref={rootRef} className={clsx('relative flex flex-col gap-1.5', className)}>
      {label ? (
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {label}
          {required ? <span className="text-error-500 ml-0.5">*</span> : null}
        </label>
      ) : null}

      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm text-left transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
          error
            ? 'border-error-500 bg-error-50 dark:bg-error-950/40'
            : 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:border-neutral-300 dark:hover:border-neutral-600',
          !selected?.label && 'text-neutral-400',
        )}
      >
        <span className="truncate">{selected?.label || placeholder}</span>
        <ChevronDown className={clsx('h-4 w-4 shrink-0 text-neutral-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg overflow-hidden"
        >
          <div className="p-2 border-b border-neutral-100 dark:border-neutral-800">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 py-1.5 pl-8 pr-2 text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-neutral-400">{noMatchesLabel}</li>
            ) : (
              filtered.map(opt => {
                const active = opt.value === value
                return (
                  <li key={opt.value || '__empty'} role="option" aria-selected={active}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(opt.value)
                        setOpen(false)
                      }}
                      className={clsx(
                        'w-full px-3 py-2 text-left text-sm truncate transition-colors',
                        active
                          ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-200'
                          : 'text-neutral-800 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-800',
                      )}
                    >
                      {opt.label}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      ) : null}

      {error ? <p className="text-xs text-error-600">{error}</p> : null}
    </div>
  )
}
