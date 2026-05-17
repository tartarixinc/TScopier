import { FOREX_NEWS_SYMBOL_OPTIONS } from '../../lib/forexNewsSymbols'

interface MarketNewsFiltersProps {
  symbol: string
  labels: {
    symbol: string
    symbolAll: string
  }
  onSymbolChange: (symbol: string) => void
}

const inputClass =
  'rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100'

export function MarketNewsFilters({ symbol, labels, onSymbolChange }: MarketNewsFiltersProps) {
  return (
    <div className="rounded-xl border border-neutral-200/80 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <label className="flex max-w-xs flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{labels.symbol}</span>
        <select className={inputClass} value={symbol} onChange={(e) => onSymbolChange(e.target.value)}>
          {FOREX_NEWS_SYMBOL_OPTIONS.map((opt) => (
            <option key={opt.value || 'all'} value={opt.value}>
              {opt.value ? opt.value : labels.symbolAll}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

