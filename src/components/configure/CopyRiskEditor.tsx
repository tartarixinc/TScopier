import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { CopyRiskTranslations } from '../../i18n/locales/copyRiskLabels'
import {
  applyCopyRiskPreset,
  type CopyOrderType,
  type CopyProtectionAction,
  type CopyRiskPreset,
  type CopyRiskSettings,
  type CopySizingMode,
} from '../../lib/copyRiskTypes'

const fieldClass = 'w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-50'

const RevisionContext = createContext(0)

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-xl border border-neutral-200 dark:border-neutral-800">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-neutral-900 dark:text-neutral-50">
        {title}
      </summary>
      <div className="space-y-3 border-t border-neutral-100 px-3 py-3 dark:border-neutral-800">{children}</div>
    </details>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-xs text-neutral-500 dark:text-neutral-400 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-center sm:gap-3">
      <span>{label}</span>
      {children}
    </label>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <Row label={label}>
      <select className={fieldClass} value={value} onChange={event => onChange(event.target.value)}>
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </Row>
  )
}

function NumberField({
  label,
  value,
  allowEmpty = false,
  onCommit,
}: {
  label: string
  value: number | null
  allowEmpty?: boolean
  onCommit: (value: number | null) => void
}) {
  const revision = useContext(RevisionContext)
  const [text, setText] = useState(value == null ? '' : String(value))
  useEffect(() => {
    setText(value == null ? '' : String(value))
  }, [value, revision])

  return (
    <Row label={label}>
      <input
        className={fieldClass}
        inputMode="decimal"
        value={text}
        onChange={event => setText(event.target.value)}
        onBlur={() => {
          const trimmed = text.trim()
          if (!trimmed) {
            if (allowEmpty) onCommit(null)
            else setText(value == null ? '' : String(value))
            return
          }
          const next = Number(trimmed)
          if (!Number.isFinite(next) || next < 0) {
            setText(value == null ? '' : String(value))
            return
          }
          onCommit(next)
        }}
      />
    </Row>
  )
}

function ToggleField({ label, checked, onLabel, offLabel, onChange }: {
  label: string
  checked: boolean
  onLabel: string
  offLabel: string
  onChange: (value: boolean) => void
}) {
  return (
    <Row label={label}>
      <button
        type="button"
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
        className="justify-self-start rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-800 dark:border-neutral-700 dark:text-neutral-100"
      >
        {checked ? onLabel : offLabel}
      </button>
    </Row>
  )
}

function looserMax(previous: number | null, next: number | null): boolean {
  if (previous == null) return false
  return next == null || next > previous
}

function UnitCap({
  title,
  valueType,
  percentLabel,
  cashLabel,
  percentValue,
  cashValue,
  typeOptions,
  currency,
  onTypeChange,
  onPercentCommit,
  onCashCommit,
}: {
  title: string
  valueType: 'off' | 'percent' | 'cash'
  percentLabel: string
  cashLabel: string
  percentValue: number | null
  cashValue: number | null
  typeOptions: { value: string; label: string }[]
  currency?: string | null
  onTypeChange: (value: 'off' | 'percent' | 'cash') => void
  onPercentCommit: (value: number | null) => void
  onCashCommit: (value: number | null) => void
}) {
  return (
    <>
      <SelectField
        label={title}
        value={valueType}
        options={typeOptions}
        onChange={value => onTypeChange(value === 'cash' ? 'cash' : value === 'percent' ? 'percent' : 'off')}
      />
      {valueType === 'cash' ? (
        <NumberField label={`${cashLabel}${currencyMark(currency)}`} value={cashValue} allowEmpty onCommit={onCashCommit} />
      ) : null}
      {valueType === 'percent' ? (
        <NumberField label={percentLabel} value={percentValue} allowEmpty onCommit={onPercentCommit} />
      ) : null}
    </>
  )
}

function looserMin(previous: number | null, next: number | null): boolean {
  if (previous == null) return false
  return next == null || next < previous
}

function currencyMark(code: string | null | undefined): string {
  const trimmed = code?.trim().toUpperCase()
  if (!trimmed) return ''
  try {
    const symbol = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: trimmed,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0).find(part => part.type === 'currency')?.value
    return symbol ? ` (${symbol})` : ` (${trimmed})`
  } catch {
    return ` (${trimmed})`
  }
}

export function CopyRiskEditor({
  settings,
  labels,
  saveError,
  currency,
  onChange,
}: {
  settings: CopyRiskSettings
  labels: CopyRiskTranslations
  saveError: string | null
  /** Follower account currency, used on cash drawdown. */
  currency?: string | null
  onChange: (next: CopyRiskSettings) => void
}) {
  const [pending, setPending] = useState<(() => void) | null>(null)
  const [revision, setRevision] = useState(0)
  const cancelPending = () => {
    setPending(null)
    setRevision(value => value + 1)
  }
  const sizing = settings.sizing
  const commit = (relaxing: boolean, apply: () => void) => {
    if (relaxing) setPending(() => apply)
    else apply()
  }
  const patch = (next: CopyRiskSettings) => onChange({ ...next, advanced: { ...next.advanced, preset: null } })

  const applyPreset = (value: string) => {
    if (!value) {
      onChange({ ...settings, advanced: { ...settings.advanced, preset: null } })
      return
    }
    const preset = value as CopyRiskPreset
    const next = applyCopyRiskPreset(preset)
    next.protection.emergency_stop = settings.protection.emergency_stop
    next.lifecycle.pause_new = settings.lifecycle.pause_new
    next.lifecycle.account_locked = settings.lifecycle.account_locked
    next.provider.suspended = settings.provider.suspended
    const relaxing = looserMax(settings.protection.max_drawdown_percent, next.protection.max_drawdown_percent)
      || looserMax(settings.protection.max_daily_loss_percent, next.protection.max_daily_loss_percent)
      || looserMax(settings.exposure.max_open_positions, next.exposure.max_open_positions)
      || looserMax(settings.exposure.max_total_lots, next.exposure.max_total_lots)
      || looserMax(settings.exposure.max_margin_used_percent, next.exposure.max_margin_used_percent)
    commit(relaxing, () => onChange(next))
  }

  const modes: { value: CopySizingMode; label: string }[] = [
    { value: 'fixed_lot', label: labels.modes.fixed_lot },
    { value: 'lot_multiplier', label: labels.modes.lot_multiplier },
    { value: 'balance_ratio', label: labels.modes.balance_ratio },
    { value: 'equity_ratio', label: labels.modes.equity_ratio },
    { value: 'percent_risk', label: labels.modes.percent_risk },
    { value: 'cash_risk', label: labels.modes.cash_risk },
    { value: 'stop_distance', label: labels.modes.stop_distance },
  ]
  const actions: { value: CopyProtectionAction; label: string }[] = [
    { value: 'pause', label: labels.actions.pause },
    { value: 'close', label: labels.actions.close },
    { value: 'close_and_pause', label: labels.actions.closeAndPause },
  ]
  const unitOptions = [
    { value: 'off', label: labels.off },
    { value: 'percent', label: labels.protection.percent },
    { value: 'cash', label: labels.protection.cash },
  ]

  return (
    <RevisionContext.Provider value={revision}>
    <div className="space-y-3">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{labels.emptyLimit}</p>
      {saveError ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{saveError}</p>
      ) : null}
      {pending ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <span className="min-w-0 flex-1">{labels.confirmRelax}</span>
          <button type="button" className="rounded-lg bg-neutral-900 px-3 py-1 text-white dark:bg-neutral-100 dark:text-neutral-900" onClick={() => { pending(); setPending(null) }}>
            {labels.confirm}
          </button>
          <button type="button" className="rounded-lg px-3 py-1" onClick={cancelPending}>
            {labels.cancel}
          </button>
        </div>
      ) : null}

      <SelectField
        label={labels.preset}
        value={settings.advanced.preset ?? ''}
        options={[
          { value: '', label: labels.presets.none },
          { value: 'conservative', label: labels.presets.conservative },
          { value: 'balanced', label: labels.presets.balanced },
          { value: 'aggressive', label: labels.presets.aggressive },
        ]}
        onChange={applyPreset}
      />

      <Section title={labels.sections.sizing}>
        <SelectField
          label={labels.sections.sizing}
          value={sizing.mode}
          options={modes}
          onChange={value => patch({ ...settings, sizing: { ...sizing, mode: value as CopySizingMode } })}
        />
        {sizing.mode === 'fixed_lot' ? (
          <NumberField label={labels.sizing.fixedLot} value={sizing.fixed_lot} onCommit={value => value != null && patch({ ...settings, sizing: { ...sizing, fixed_lot: value } })} />
        ) : null}
        {sizing.mode === 'lot_multiplier' ? (
          <NumberField label={labels.sizing.lotMultiplier} value={sizing.lot_multiplier} onCommit={value => value != null && patch({ ...settings, sizing: { ...sizing, lot_multiplier: value } })} />
        ) : null}
        {sizing.mode === 'balance_ratio' ? (
          <NumberField label={labels.sizing.balanceMultiplier} value={sizing.balance_multiplier} onCommit={value => value != null && patch({ ...settings, sizing: { ...sizing, balance_multiplier: value } })} />
        ) : null}
        {sizing.mode === 'equity_ratio' ? (
          <NumberField label={labels.sizing.equityMultiplier} value={sizing.equity_multiplier} onCommit={value => value != null && patch({ ...settings, sizing: { ...sizing, equity_multiplier: value } })} />
        ) : null}
        {sizing.mode === 'percent_risk' ? (
          <NumberField label={labels.sizing.percentRisk} value={sizing.percent_risk} onCommit={value => value != null && patch({ ...settings, sizing: { ...sizing, percent_risk: value } })} />
        ) : null}
        {sizing.mode === 'cash_risk' ? (
          <NumberField label={labels.sizing.cashRisk} value={sizing.cash_risk} onCommit={value => value != null && patch({ ...settings, sizing: { ...sizing, cash_risk: value } })} />
        ) : null}
        {sizing.mode === 'stop_distance' ? (
          <>
            <NumberField label={labels.sizing.fixedLot} value={sizing.fixed_lot} onCommit={value => value != null && patch({ ...settings, sizing: { ...sizing, fixed_lot: value } })} />
            <NumberField label={labels.sizing.referencePips} value={sizing.stop_distance_reference_pips} onCommit={value => value != null && value > 0 && patch({ ...settings, sizing: { ...sizing, stop_distance_reference_pips: value } })} />
          </>
        ) : null}
      </Section>

      <Section title={labels.sections.protection}>
        <SelectField
          label={labels.protection.action}
          value={settings.protection.action}
          options={actions}
          onChange={value => patch({ ...settings, protection: { ...settings.protection, action: value as CopyProtectionAction } })}
        />
        <ToggleField label={labels.protection.emergency} checked={settings.protection.emergency_stop} onLabel={labels.on} offLabel={labels.off} onChange={value => onChange({
          ...settings,
          protection: { ...settings.protection, emergency_stop: value },
          lifecycle: { ...settings.lifecycle, pause_new: value ? true : settings.lifecycle.pause_new },
        })} />
        <ToggleField label={labels.protection.recovery} checked={settings.protection.recovery_mode} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, protection: { ...settings.protection, recovery_mode: value } })} />
        <UnitCap
          title={labels.protection.maxDrawdown}
          valueType={settings.protection.drawdown_value_type}
          percentLabel={labels.protection.maxDrawdownPercent}
          cashLabel={labels.protection.maxDrawdownCash}
          percentValue={settings.protection.max_drawdown_percent}
          cashValue={settings.protection.max_drawdown_cash}
          typeOptions={unitOptions}
          currency={currency}
          onTypeChange={value => patch({ ...settings, protection: { ...settings.protection, drawdown_value_type: value } })}
          onPercentCommit={value => commit(looserMax(settings.protection.max_drawdown_percent, value), () => patch({
            ...settings,
            protection: { ...settings.protection, max_drawdown_percent: value },
          }))}
          onCashCommit={value => commit(looserMax(settings.protection.max_drawdown_cash, value), () => patch({
            ...settings,
            protection: { ...settings.protection, max_drawdown_cash: value },
          }))}
        />
        <UnitCap
          title={labels.protection.dailyLoss}
          valueType={settings.protection.daily_loss_value_type}
          percentLabel={labels.protection.dailyLossPercent}
          cashLabel={labels.protection.dailyLossCash}
          percentValue={settings.protection.max_daily_loss_percent}
          cashValue={settings.protection.max_daily_loss_cash}
          typeOptions={unitOptions}
          currency={currency}
          onTypeChange={value => patch({ ...settings, protection: { ...settings.protection, daily_loss_value_type: value } })}
          onPercentCommit={value => commit(looserMax(settings.protection.max_daily_loss_percent, value), () => patch({
            ...settings,
            protection: { ...settings.protection, max_daily_loss_percent: value },
          }))}
          onCashCommit={value => commit(looserMax(settings.protection.max_daily_loss_cash, value), () => patch({
            ...settings,
            protection: { ...settings.protection, max_daily_loss_cash: value },
          }))}
        />
        <UnitCap
          title={labels.protection.weeklyLoss}
          valueType={settings.protection.weekly_loss_value_type}
          percentLabel={labels.protection.weeklyLossPercent}
          cashLabel={labels.protection.weeklyLossCash}
          percentValue={settings.protection.max_weekly_loss_percent}
          cashValue={settings.protection.max_weekly_loss_cash}
          typeOptions={unitOptions}
          currency={currency}
          onTypeChange={value => patch({ ...settings, protection: { ...settings.protection, weekly_loss_value_type: value } })}
          onPercentCommit={value => commit(looserMax(settings.protection.max_weekly_loss_percent, value), () => patch({
            ...settings,
            protection: { ...settings.protection, max_weekly_loss_percent: value },
          }))}
          onCashCommit={value => commit(looserMax(settings.protection.max_weekly_loss_cash, value), () => patch({
            ...settings,
            protection: { ...settings.protection, max_weekly_loss_cash: value },
          }))}
        />
        <UnitCap
          title={labels.protection.monthlyLoss}
          valueType={settings.protection.monthly_loss_value_type}
          percentLabel={labels.protection.monthlyLossPercent}
          cashLabel={labels.protection.monthlyLossCash}
          percentValue={settings.protection.max_monthly_loss_percent}
          cashValue={settings.protection.max_monthly_loss_cash}
          typeOptions={unitOptions}
          currency={currency}
          onTypeChange={value => patch({ ...settings, protection: { ...settings.protection, monthly_loss_value_type: value } })}
          onPercentCommit={value => commit(looserMax(settings.protection.max_monthly_loss_percent, value), () => patch({
            ...settings,
            protection: { ...settings.protection, max_monthly_loss_percent: value },
          }))}
          onCashCommit={value => commit(looserMax(settings.protection.max_monthly_loss_cash, value), () => patch({
            ...settings,
            protection: { ...settings.protection, max_monthly_loss_cash: value },
          }))}
        />
        <UnitCap
          title={labels.protection.floatingLoss}
          valueType={settings.protection.floating_loss_value_type}
          percentLabel={labels.protection.floatingLossPercent}
          cashLabel={labels.protection.floatingLoss}
          percentValue={settings.protection.floating_loss_percent}
          cashValue={settings.protection.floating_loss}
          typeOptions={unitOptions}
          currency={currency}
          onTypeChange={value => patch({ ...settings, protection: { ...settings.protection, floating_loss_value_type: value } })}
          onPercentCommit={value => commit(looserMax(settings.protection.floating_loss_percent, value), () => patch({
            ...settings,
            protection: { ...settings.protection, floating_loss_percent: value },
          }))}
          onCashCommit={value => commit(looserMax(settings.protection.floating_loss, value), () => patch({
            ...settings,
            protection: { ...settings.protection, floating_loss: value },
          }))}
        />
        <CapFields
          fields={[
            [labels.protection.maxEquityLoss, settings.protection.max_equity_loss, 'max_equity_loss'],
            [labels.protection.giveback, settings.protection.floating_profit_giveback, 'floating_profit_giveback'],
            [labels.protection.profitLock, settings.protection.profit_target_lock, 'profit_target_lock'],
            [labels.protection.dailyProfit, settings.protection.daily_profit_target, 'daily_profit_target'],
            [labels.protection.consecutiveLosses, settings.protection.max_consecutive_losses, 'max_consecutive_losses'],
          ]}
          onCommit={(key, value) => {
            const previous = settings.protection[key]
            commit(looserMax(previous, value), () => patch({
              ...settings,
              protection: { ...settings.protection, [key]: value },
            }))
          }}
        />
        <NumberField
          label={labels.protection.minEquity}
          value={settings.protection.min_equity}
          allowEmpty
          onCommit={value => commit(looserMin(settings.protection.min_equity, value), () => patch({
            ...settings,
            protection: { ...settings.protection, min_equity: value },
          }))}
        />
      </Section>

      <Section title={labels.sections.exposure}>
        <CapFields
          fields={[
            [labels.exposure.maxPositions, settings.exposure.max_open_positions, 'max_open_positions'],
            [labels.exposure.maxLots, settings.exposure.max_total_lots, 'max_total_lots'],
            [labels.exposure.maxPositionsSymbol, settings.exposure.max_positions_per_symbol, 'max_positions_per_symbol'],
            [labels.exposure.maxLotsSymbol, settings.exposure.max_lots_per_symbol, 'max_lots_per_symbol'],
            [labels.exposure.maxSameDirection, settings.exposure.max_same_direction, 'max_same_direction'],
            [labels.exposure.maxPending, settings.exposure.max_pending_orders, 'max_pending_orders'],
            [labels.exposure.maxOrderVolume, settings.exposure.max_order_volume, 'max_order_volume'],
            [labels.exposure.maxMarginPercent, settings.exposure.max_margin_used_percent, 'max_margin_used_percent'],
            [labels.exposure.maxMarginOrder, settings.exposure.max_margin_per_order, 'max_margin_per_order'],
            [labels.exposure.maxStopRisk, settings.exposure.max_aggregate_stop_risk, 'max_aggregate_stop_risk'],
            [labels.exposure.maxStopRiskSymbol, settings.exposure.max_stop_risk_per_symbol, 'max_stop_risk_per_symbol'],
            [labels.exposure.maxStopRiskProvider, settings.exposure.max_stop_risk_per_provider, 'max_stop_risk_per_provider'],
          ]}
          onCommit={(key, value) => {
            const previous = settings.exposure[key]
            commit(looserMax(previous, value), () => patch({
              ...settings,
              exposure: { ...settings.exposure, [key]: value },
            }))
          }}
        />
        <NumberField
          label={labels.exposure.minFreeMargin}
          value={settings.exposure.min_free_margin}
          allowEmpty
          onCommit={value => commit(looserMin(settings.exposure.min_free_margin, value), () => patch({
            ...settings,
            exposure: { ...settings.exposure, min_free_margin: value },
          }))}
        />
      </Section>

      <Section title={labels.sections.stops}>
        <ToggleField label={labels.stops.copySl} checked={settings.stops.copy_source_sl} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, stops: { ...settings.stops, copy_source_sl: value } })} />
        <ToggleField label={labels.stops.copyTp} checked={settings.stops.copy_source_tp} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, stops: { ...settings.stops, copy_source_tp: value } })} />
        <ToggleField label={labels.stops.forceSl} checked={settings.stops.force_sl} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, stops: { ...settings.stops, force_sl: value } })} />
        <ToggleField label={labels.stops.forceTp} checked={settings.stops.force_tp} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, stops: { ...settings.stops, force_tp: value } })} />
        <NumberField label={labels.stops.fixedSl} value={settings.stops.fixed_sl_pips} allowEmpty onCommit={value => patch({ ...settings, stops: { ...settings.stops, fixed_sl_pips: value } })} />
        <NumberField label={labels.stops.fixedTp} value={settings.stops.fixed_tp_pips} allowEmpty onCommit={value => patch({ ...settings, stops: { ...settings.stops, fixed_tp_pips: value } })} />
        <NumberField label={labels.stops.slMultiplier} value={settings.stops.sl_multiplier} onCommit={value => value != null && patch({ ...settings, stops: { ...settings.stops, sl_multiplier: value } })} />
        <NumberField label={labels.stops.tpMultiplier} value={settings.stops.tp_multiplier} onCommit={value => value != null && patch({ ...settings, stops: { ...settings.stops, tp_multiplier: value } })} />
        <NumberField label={labels.stops.slOffset} value={settings.stops.sl_offset_pips} onCommit={value => value != null && patch({ ...settings, stops: { ...settings.stops, sl_offset_pips: value } })} />
        <NumberField label={labels.stops.tpOffset} value={settings.stops.tp_offset_pips} onCommit={value => value != null && patch({ ...settings, stops: { ...settings.stops, tp_offset_pips: value } })} />
        <NumberField label={labels.stops.minSl} value={settings.stops.min_sl_pips} allowEmpty onCommit={value => commit(looserMin(settings.stops.min_sl_pips, value), () => patch({ ...settings, stops: { ...settings.stops, min_sl_pips: value } }))} />
        <NumberField label={labels.stops.maxSl} value={settings.stops.max_sl_pips} allowEmpty onCommit={value => commit(looserMax(settings.stops.max_sl_pips, value), () => patch({ ...settings, stops: { ...settings.stops, max_sl_pips: value } }))} />
        <NumberField label={labels.stops.minRr} value={settings.stops.min_rr} allowEmpty onCommit={value => commit(looserMin(settings.stops.min_rr, value), () => patch({ ...settings, stops: { ...settings.stops, min_rr: value } }))} />
        <NumberField label={labels.stops.maxRr} value={settings.stops.max_rr} allowEmpty onCommit={value => commit(looserMax(settings.stops.max_rr, value), () => patch({ ...settings, stops: { ...settings.stops, max_rr: value } }))} />
        <ToggleField label={labels.stops.neverWiden} checked={settings.stops.never_widen_sl} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, stops: { ...settings.stops, never_widen_sl: value } })} />
        <ToggleField label={labels.stops.closeOnExit} checked={settings.stops.close_on_source_exit} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, stops: { ...settings.stops, close_on_source_exit: value } })} />
        <NumberField label={labels.stops.maxModifications} value={settings.stops.max_sl_modifications} allowEmpty onCommit={value => commit(looserMax(settings.stops.max_sl_modifications, value), () => patch({ ...settings, stops: { ...settings.stops, max_sl_modifications: value } }))} />
      </Section>

      <Section title={labels.sections.filters}>
        <SelectField
          label={labels.filters.direction}
          value={settings.filters.direction}
          options={[
            { value: 'both', label: labels.directions.both },
            { value: 'buy', label: labels.directions.buy },
            { value: 'sell', label: labels.directions.sell },
          ]}
          onChange={value => patch({ ...settings, filters: { ...settings.filters, direction: value as CopyRiskSettings['filters']['direction'] } })}
        />
        <div className="flex flex-wrap gap-3 text-sm text-neutral-700 dark:text-neutral-200">
          {(['market', 'limit', 'stop'] as CopyOrderType[]).map(orderType => (
            <label key={orderType} className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.filters.order_types.includes(orderType)}
                onChange={event => {
                  const next = event.target.checked
                    ? [...settings.filters.order_types, orderType]
                    : settings.filters.order_types.filter(item => item !== orderType)
                  if (next.length === 0) return
                  patch({ ...settings, filters: { ...settings.filters, order_types: next } })
                }}
              />
              {labels.orderTypes[orderType]}
            </label>
          ))}
        </div>
        <NumberField label={labels.filters.minVolume} value={settings.filters.min_source_volume} allowEmpty onCommit={value => patch({ ...settings, filters: { ...settings.filters, min_source_volume: value } })} />
        <NumberField label={labels.filters.maxVolume} value={settings.filters.max_source_volume} allowEmpty onCommit={value => commit(looserMax(settings.filters.max_source_volume, value), () => patch({ ...settings, filters: { ...settings.filters, max_source_volume: value } }))} />
        <NumberField label={labels.filters.maxSpread} value={settings.filters.max_spread_points} allowEmpty onCommit={value => commit(looserMax(settings.filters.max_spread_points, value), () => patch({ ...settings, filters: { ...settings.filters, max_spread_points: value } }))} />
        <NumberField label={labels.filters.maxDeviation} value={settings.filters.max_entry_deviation_points} allowEmpty onCommit={value => commit(looserMax(settings.filters.max_entry_deviation_points, value), () => patch({ ...settings, filters: { ...settings.filters, max_entry_deviation_points: value } }))} />
        <NumberField label={labels.filters.maxPriceMove} value={settings.filters.max_price_move_points} allowEmpty onCommit={value => commit(looserMax(settings.filters.max_price_move_points, value), () => patch({ ...settings, filters: { ...settings.filters, max_price_move_points: value } }))} />
        <NumberField label={labels.filters.maxAge} value={settings.filters.max_signal_age_seconds} allowEmpty onCommit={value => commit(looserMax(settings.filters.max_signal_age_seconds, value), () => patch({ ...settings, filters: { ...settings.filters, max_signal_age_seconds: value } }))} />
        <NumberField label={labels.filters.maxPositionAge} value={settings.filters.max_source_position_age_seconds} allowEmpty onCommit={value => commit(looserMax(settings.filters.max_source_position_age_seconds, value), () => patch({ ...settings, filters: { ...settings.filters, max_source_position_age_seconds: value } }))} />
        <ToggleField label={labels.filters.requireStop} checked={settings.filters.require_stop} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, filters: { ...settings.filters, require_stop: value } })} />
        <NumberField label={labels.filters.minRr} value={settings.filters.min_reward_risk} allowEmpty onCommit={value => commit(looserMin(settings.filters.min_reward_risk, value), () => patch({ ...settings, filters: { ...settings.filters, min_reward_risk: value } }))} />
        <NumberField label={labels.filters.maxCopies} value={settings.filters.max_copies_per_period} allowEmpty onCommit={value => commit(looserMax(settings.filters.max_copies_per_period, value), () => patch({ ...settings, filters: { ...settings.filters, max_copies_per_period: value } }))} />
        <NumberField label={labels.filters.minGap} value={settings.filters.min_seconds_between_copies} allowEmpty onCommit={value => commit(looserMin(settings.filters.min_seconds_between_copies, value), () => patch({ ...settings, filters: { ...settings.filters, min_seconds_between_copies: value } }))} />
      </Section>

      <Section title={labels.sections.execution}>
        <NumberField label={labels.execution.maxDeviation} value={settings.execution.max_deviation_points} allowEmpty onCommit={value => commit(looserMax(settings.execution.max_deviation_points, value), () => patch({ ...settings, execution: { ...settings.execution, max_deviation_points: value } }))} />
        <NumberField label={labels.execution.maxLatency} value={settings.execution.max_latency_seconds} allowEmpty onCommit={value => commit(looserMax(settings.execution.max_latency_seconds, value), () => patch({ ...settings, execution: { ...settings.execution, max_latency_seconds: value } }))} />
        <NumberField label={labels.execution.maxSpread} value={settings.execution.max_spread_points} allowEmpty onCommit={value => commit(looserMax(settings.execution.max_spread_points, value), () => patch({ ...settings, execution: { ...settings.execution, max_spread_points: value } }))} />
        <ToggleField label={labels.execution.rejectMargin} checked={settings.execution.reject_insufficient_margin} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, execution: { ...settings.execution, reject_insufficient_margin: value } })} />
        <NumberField label={labels.execution.retryLimit} value={settings.execution.retry_limit} onCommit={value => value != null && patch({ ...settings, execution: { ...settings.execution, retry_limit: Math.floor(value) } })} />
        <NumberField label={labels.execution.retryDeadline} value={settings.execution.retry_deadline_seconds} allowEmpty onCommit={value => patch({ ...settings, execution: { ...settings.execution, retry_deadline_seconds: value } })} />
        <NumberField label={labels.execution.failurePause} value={settings.execution.failure_pause_after} allowEmpty onCommit={value => commit(looserMax(settings.execution.failure_pause_after, value), () => patch({ ...settings, execution: { ...settings.execution, failure_pause_after: value } }))} />
        <NumberField label={labels.execution.slippagePause} value={settings.execution.slippage_pause_after} allowEmpty onCommit={value => commit(looserMax(settings.execution.slippage_pause_after, value), () => patch({ ...settings, execution: { ...settings.execution, slippage_pause_after: value } }))} />
        <NumberField label={labels.execution.maxSnapshotAge} value={settings.execution.max_snapshot_age_seconds} allowEmpty onCommit={value => commit(looserMax(settings.execution.max_snapshot_age_seconds, value), () => patch({ ...settings, execution: { ...settings.execution, max_snapshot_age_seconds: value } }))} />
      </Section>

      <Section title={labels.sections.provider}>
        <NumberField label={labels.provider.allocation} value={settings.provider.allocation_percent} allowEmpty onCommit={value => commit(looserMax(settings.provider.allocation_percent, value), () => patch({ ...settings, provider: { ...settings.provider, allocation_percent: value } }))} />
        <NumberField label={labels.provider.maxLoss} value={settings.provider.max_loss} allowEmpty onCommit={value => commit(looserMax(settings.provider.max_loss, value), () => patch({ ...settings, provider: { ...settings.provider, max_loss: value } }))} />
        <NumberField label={labels.provider.maxDrawdown} value={settings.provider.max_drawdown_percent} allowEmpty onCommit={value => commit(looserMax(settings.provider.max_drawdown_percent, value), () => patch({ ...settings, provider: { ...settings.provider, max_drawdown_percent: value } }))} />
        <NumberField label={labels.provider.maxPositions} value={settings.provider.max_open_positions} allowEmpty onCommit={value => commit(looserMax(settings.provider.max_open_positions, value), () => patch({ ...settings, provider: { ...settings.provider, max_open_positions: value } }))} />
        <NumberField label={labels.provider.maxLots} value={settings.provider.max_lots} allowEmpty onCommit={value => commit(looserMax(settings.provider.max_lots, value), () => patch({ ...settings, provider: { ...settings.provider, max_lots: value } }))} />
        <NumberField label={labels.provider.maxDailyTrades} value={settings.provider.max_daily_trades} allowEmpty onCommit={value => commit(looserMax(settings.provider.max_daily_trades, value), () => patch({ ...settings, provider: { ...settings.provider, max_daily_trades: value } }))} />
        <NumberField label={labels.provider.riskMultiplier} value={settings.provider.risk_multiplier} onCommit={value => value != null && patch({ ...settings, provider: { ...settings.provider, risk_multiplier: value } })} />
        <NumberField label={labels.provider.consecutiveLosses} value={settings.provider.max_consecutive_losses} allowEmpty onCommit={value => commit(looserMax(settings.provider.max_consecutive_losses, value), () => patch({ ...settings, provider: { ...settings.provider, max_consecutive_losses: value } }))} />
        <ToggleField label={labels.provider.suspended} checked={settings.provider.suspended} onLabel={labels.on} offLabel={labels.off} onChange={value => onChange({ ...settings, provider: { ...settings.provider, suspended: value } })} />
      </Section>

      <Section title={labels.sections.advanced}>
        <ToggleField label={labels.advanced.autoReduce} checked={settings.advanced.auto_reduce} onLabel={labels.on} offLabel={labels.off} onChange={value => patch({ ...settings, advanced: { ...settings.advanced, auto_reduce: value } })} />
        <NumberField label={labels.advanced.budget} value={settings.advanced.account_risk_budget} allowEmpty onCommit={value => commit(looserMax(settings.advanced.account_risk_budget, value), () => patch({ ...settings, advanced: { ...settings.advanced, account_risk_budget: value } }))} />
        <div className="space-y-2">
          <div className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{labels.advanced.drawdownStep}</div>
          {settings.advanced.drawdown_steps.map((step, index) => (
            <div key={`${step.drawdown_percent}-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <input className={fieldClass} aria-label={labels.advanced.stepDrawdown} defaultValue={step.drawdown_percent} inputMode="decimal" onBlur={event => {
                const drawdown = Number(event.target.value)
                if (!Number.isFinite(drawdown) || drawdown <= 0) return
                const drawdown_steps = settings.advanced.drawdown_steps.map((item, itemIndex) => (
                  itemIndex === index ? { ...item, drawdown_percent: drawdown } : item
                ))
                patch({ ...settings, advanced: { ...settings.advanced, drawdown_steps } })
              }} />
              <input className={fieldClass} aria-label={labels.advanced.stepMultiplier} defaultValue={step.lot_multiplier} inputMode="decimal" onBlur={event => {
                const multiplier = Number(event.target.value)
                if (!Number.isFinite(multiplier) || multiplier < 0) return
                const drawdown_steps = settings.advanced.drawdown_steps.map((item, itemIndex) => (
                  itemIndex === index ? { ...item, lot_multiplier: multiplier } : item
                ))
                patch({ ...settings, advanced: { ...settings.advanced, drawdown_steps } })
              }} />
              <button type="button" className="text-xs text-red-600" onClick={() => patch({
                ...settings,
                advanced: {
                  ...settings.advanced,
                  drawdown_steps: settings.advanced.drawdown_steps.filter((_, itemIndex) => itemIndex !== index),
                },
              })}
              >
                {labels.remove}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-xs font-medium text-teal-700 dark:text-teal-300"
            onClick={() => patch({
              ...settings,
              advanced: {
                ...settings.advanced,
                drawdown_steps: [...settings.advanced.drawdown_steps, { drawdown_percent: 5, lot_multiplier: 0.5 }],
              },
            })}
          >
            {labels.add}
          </button>
        </div>
      </Section>

      <Section title={labels.sections.lifecycle}>
        <ToggleField label={labels.lifecycle.pauseNew} checked={settings.lifecycle.pause_new} onLabel={labels.on} offLabel={labels.off} onChange={value => onChange({ ...settings, lifecycle: { ...settings.lifecycle, pause_new: value } })} />
        <NumberField label={labels.lifecycle.disconnectAfter} value={settings.lifecycle.disconnect_action_after_seconds} allowEmpty onCommit={value => patch({ ...settings, lifecycle: { ...settings.lifecycle, disconnect_action_after_seconds: value } })} />
        <SelectField
          label={labels.lifecycle.disconnectAction}
          value={settings.lifecycle.disconnect_action}
          options={actions}
          onChange={value => patch({ ...settings, lifecycle: { ...settings.lifecycle, disconnect_action: value as CopyProtectionAction } })}
        />
        <NumberField
          label={labels.lifecycle.maxUtilization}
          value={settings.lifecycle.max_account_utilization_percent}
          allowEmpty
          onCommit={value => commit(looserMax(settings.lifecycle.max_account_utilization_percent, value), () => patch({
            ...settings,
            lifecycle: { ...settings.lifecycle, max_account_utilization_percent: value },
          }))}
        />
        <ToggleField
          label={labels.lifecycle.accountLock}
          checked={settings.lifecycle.account_locked}
          onLabel={labels.on}
          offLabel={labels.off}
          onChange={value => onChange({ ...settings, lifecycle: { ...settings.lifecycle, account_locked: value, pause_new: value ? true : settings.lifecycle.pause_new } })}
        />
      </Section>
    </div>
    </RevisionContext.Provider>
  )
}

function CapFields<Key extends string>({
  fields,
  onCommit,
}: {
  fields: Array<[string, number | null, Key]>
  onCommit: (key: Key, value: number | null) => void
}) {
  return (
    <>
      {fields.map(([label, value, key]) => (
        <NumberField key={key} label={label} value={value} allowEmpty onCommit={next => onCommit(key, next)} />
      ))}
    </>
  )
}
