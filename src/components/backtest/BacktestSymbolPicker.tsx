import { useMemo, useState } from 'react'
import clsx from 'clsx'

function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

interface BacktestSymbolPickerProps {
  availableSymbols: string[]
  selected: string[]
  onChange: (symbols: string[]) => void
  disabled?: boolean
}

export function BacktestSymbolPicker({
  availableSymbols,
  selected,
  onChange,
  disabled,
}: BacktestSymbolPickerProps) {
  const [draft, setDraft] = useState('')

  const chipSymbols = useMemo(() => {
    const set = new Set<string>()
    for (const s of availableSymbols) {
      const n = normalizeSymbol(s)
      if (n) set.add(n)
    }
    for (const s of selected) {
      const n = normalizeSymbol(s)
      if (n) set.add(n)
    }
    return [...set].sort()
  }, [availableSymbols, selected])

  const toggle = (sym: string) => {
    if (disabled) return
    if (selected.includes(sym)) {
      onChange(selected.filter(s => s !== sym))
    } else {
      onChange([...selected, sym].sort())
    }
  }

  const addDraft = () => {
    const sym = normalizeSymbol(draft)
    if (!sym || disabled) return
    if (!selected.includes(sym)) onChange([...selected, sym].sort())
    setDraft('')
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 max-h-28 overflow-y-auto">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([])}
          className={clsx(
            'px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors',
            selected.length === 0
              ? 'bg-teal-50 border-teal-300 text-teal-800 dark:bg-teal-950/50 dark:border-teal-700 dark:text-teal-200'
              : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          All symbols
        </button>
        {chipSymbols.map(sym => (
          <button
            key={sym}
            type="button"
            disabled={disabled}
            onClick={() => toggle(sym)}
            className={clsx(
              'px-2.5 py-1 rounded-lg text-xs font-medium border font-mono transition-colors',
              selected.includes(sym)
                ? 'bg-teal-50 border-teal-300 text-teal-800 dark:bg-teal-950/50 dark:border-teal-700 dark:text-teal-200'
                : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            {sym}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          disabled={disabled}
          onChange={e => setDraft(e.target.value.toUpperCase())}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addDraft()
            }
          }}
          placeholder="Add symbol (e.g. XAUUSD)"
          className="flex-1 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-xs font-mono"
        />
        <button
          type="button"
          disabled={disabled || !normalizeSymbol(draft)}
          onClick={addDraft}
          className="shrink-0 rounded-lg border border-neutral-200 dark:border-neutral-700 px-2.5 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
        {selected.length === 0
          ? 'All symbols from the channel(s) in this date range will be backtested.'
          : `Only ${selected.join(', ')} — other channel symbols are ignored.`}
        {chipSymbols.length === 0
          ? ' Run a backtest once (or import history) to discover symbols from Telegram.'
          : null}
      </p>
    </div>
  )
}
