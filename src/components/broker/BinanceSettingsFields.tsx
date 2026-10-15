import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import type { BinanceMarginMode, BinanceSettingsDraft } from '../../lib/binanceBroker'
import { BINANCE_MAX_LEVERAGE } from '../../lib/binanceBroker'
import { Input } from '../ui/Input'

type BinanceSettingsFieldsProps = {
  value: BinanceSettingsDraft
  onChange: (next: BinanceSettingsDraft) => void
  marginError?: string
  leverageError?: string
  disabled?: boolean
}

const MODES: BinanceMarginMode[] = ['isolated', 'cross']

/** Margin, leverage and margin mode. Used by the connect form and the post-link editor. */
export function BinanceSettingsFields({
  value,
  onChange,
  marginError,
  leverageError,
  disabled,
}: BinanceSettingsFieldsProps) {
  const cf = useT().accountConfig.connectForm

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          label={cf.binanceMarginLabel}
          hint={cf.binanceMarginHint}
          inputMode="decimal"
          value={value.marginUsdt}
          error={marginError}
          disabled={disabled}
          onChange={event => onChange({ ...value, marginUsdt: event.target.value })}
        />
        <Input
          label={cf.binanceLeverageLabel}
          hint={cf.binanceLeverageHint}
          inputMode="numeric"
          max={BINANCE_MAX_LEVERAGE}
          value={value.leverage}
          error={leverageError}
          disabled={disabled}
          onChange={event => onChange({ ...value, leverage: event.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{cf.binanceMarginModeLabel}</p>
        <div className="grid grid-cols-2 gap-2">
          {MODES.map(mode => (
            <button
              key={mode}
              type="button"
              disabled={disabled}
              aria-pressed={value.marginMode === mode}
              onClick={() => onChange({ ...value, marginMode: mode })}
              className={clsx(
                'rounded-xl border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50',
                value.marginMode === mode
                  ? 'border-green-400 bg-teal-50 text-teal-900 dark:border-green-400 dark:bg-teal-950/40 dark:text-teal-100'
                  : 'border-neutral-200/65 bg-white text-neutral-900 hover:border-neutral-300 dark:border-neutral-800/55 dark:bg-neutral-900 dark:text-neutral-50 dark:hover:border-neutral-700',
              )}
            >
              {mode === 'isolated' ? cf.binanceIsolated : cf.binanceCross}
            </button>
          ))}
        </div>
        <p className="text-xs text-neutral-900 dark:text-neutral-50">{cf.binanceMarginModeHint}</p>
      </div>
    </div>
  )
}
