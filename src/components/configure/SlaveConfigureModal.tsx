import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowRight, Check, ShieldCheck, X } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { CopyRiskEditor } from './CopyRiskEditor'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { interpolate } from '../../i18n/interpolate'
import type { CopyRiskTranslations } from '../../i18n/locales/copyRiskLabels'
import type { MirrorTradingPageTranslations } from '../../i18n/locales/types'
import { getBrokerDisplayLabel } from '../../lib/brokerChannelLink'
import { resolveAccountLogin } from '../../lib/brokerFromServer'
import type {
  CopyProtectionAction,
  CopyRiskSettings,
  CopySizingMode,
} from '../../lib/copyRiskTypes'
import { resolveBrokerTotalBalance } from '../../lib/effectiveBrokerBalance'
import type { BrokerAccount } from '../../types/database'

const MULTIPLIERS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const
const EXAMPLE_LOT = 1
type SimpleMethod = 'proportional' | 'fixed_lot' | 'risk_multiplier'
const MODES: CopySizingMode[] = [
  'fixed_lot',
  'lot_multiplier',
  'balance_ratio',
  'equity_ratio',
  'percent_risk',
  'cash_risk',
  'stop_distance',
]

type SetupCopy = MirrorTradingPageTranslations['setup']
type PreviewRow = { label: string; value: string }
type PreviewGroup = { title: string; rows: PreviewRow[] }

function onOff(value: boolean, labels: CopyRiskTranslations): string {
  return value ? labels.on : labels.off
}

function shownNumber(value: number | null | undefined, off: string): string {
  return value == null || !Number.isFinite(value) ? off : String(value)
}

function unitValue(
  type: 'off' | 'percent' | 'cash',
  percent: number | null,
  cash: number | null,
  off: string,
): string {
  if (type === 'percent') return shownNumber(percent, off) === off ? off : `${percent}%`
  if (type === 'cash') return shownNumber(cash, off)
  return off
}

function actionLabel(action: CopyProtectionAction, labels: CopyRiskTranslations): string {
  if (action === 'close_and_pause') return labels.actions.closeAndPause
  if (action === 'close') return labels.actions.close
  return labels.actions.pause
}

function previewGroups(
  settings: CopyRiskSettings,
  labels: CopyRiskTranslations,
  lotLabel: string,
  lotValue: string,
): PreviewGroup[] {
  const off = labels.off
  const sizing = settings.sizing
  const stops = settings.stops
  const protection = settings.protection
  const exposure = settings.exposure
  const filters = settings.filters
  const execution = settings.execution
  const provider = settings.provider
  const advanced = settings.advanced
  const lifecycle = settings.lifecycle
  return [
    {
      title: labels.sections.sizing,
      rows: [
        { label: labels.sections.sizing, value: labels.modes[sizing.mode] },
        { label: labels.sizing.fixedLot, value: String(sizing.fixed_lot) },
        { label: labels.sizing.lotMultiplier, value: `${sizing.lot_multiplier}x` },
        { label: labels.sizing.balanceMultiplier, value: `${sizing.balance_multiplier}x` },
        { label: labels.sizing.equityMultiplier, value: `${sizing.equity_multiplier}x` },
        { label: labels.sizing.percentRisk, value: `${sizing.percent_risk}%` },
        { label: labels.sizing.cashRisk, value: String(sizing.cash_risk) },
        { label: labels.sizing.referencePips, value: String(sizing.stop_distance_reference_pips) },
        { label: labels.sizing.minLot, value: String(sizing.min_lot) },
        { label: labels.sizing.maxLot, value: shownNumber(sizing.max_lot, off) },
        {
          label: labels.sizing.symbolOverride,
          value: sizing.symbol_overrides.length
            ? sizing.symbol_overrides.map(row => `${row.symbol || '—'} ${row.fixed_lot}`).join(', ')
            : off,
        },
        { label: lotLabel, value: lotValue },
      ],
    },
    {
      title: labels.sections.stops,
      rows: [
        { label: labels.stops.copySl, value: onOff(stops.copy_source_sl, labels) },
        { label: labels.stops.copyTp, value: onOff(stops.copy_source_tp, labels) },
        { label: labels.stops.forceSl, value: onOff(stops.force_sl, labels) },
        { label: labels.stops.forceTp, value: onOff(stops.force_tp, labels) },
        { label: labels.stops.fixedSl, value: shownNumber(stops.fixed_sl_pips, off) },
        { label: labels.stops.fixedTp, value: shownNumber(stops.fixed_tp_pips, off) },
        { label: labels.stops.slMultiplier, value: String(stops.sl_multiplier) },
        { label: labels.stops.tpMultiplier, value: String(stops.tp_multiplier) },
        { label: labels.stops.slOffset, value: String(stops.sl_offset_pips) },
        { label: labels.stops.tpOffset, value: String(stops.tp_offset_pips) },
        { label: labels.stops.minSl, value: shownNumber(stops.min_sl_pips, off) },
        { label: labels.stops.maxSl, value: shownNumber(stops.max_sl_pips, off) },
        { label: labels.stops.minRr, value: shownNumber(stops.min_rr, off) },
        { label: labels.stops.maxRr, value: shownNumber(stops.max_rr, off) },
        { label: labels.stops.neverWiden, value: onOff(stops.never_widen_sl, labels) },
        { label: labels.stops.closeOnExit, value: onOff(stops.close_on_source_exit, labels) },
        { label: labels.stops.maxModifications, value: shownNumber(stops.max_sl_modifications, off) },
      ],
    },
    {
      title: labels.sections.protection,
      rows: [
        { label: labels.protection.action, value: actionLabel(protection.action, labels) },
        { label: labels.protection.emergency, value: onOff(protection.emergency_stop, labels) },
        { label: labels.protection.recovery, value: onOff(protection.recovery_mode, labels) },
        { label: labels.protection.maxDrawdown, value: unitValue(protection.drawdown_value_type, protection.max_drawdown_percent, protection.max_drawdown_cash, off) },
        { label: labels.protection.dailyLoss, value: unitValue(protection.daily_loss_value_type, protection.max_daily_loss_percent, protection.max_daily_loss_cash, off) },
        { label: labels.protection.weeklyLoss, value: unitValue(protection.weekly_loss_value_type, protection.max_weekly_loss_percent, protection.max_weekly_loss_cash, off) },
        { label: labels.protection.monthlyLoss, value: unitValue(protection.monthly_loss_value_type, protection.max_monthly_loss_percent, protection.max_monthly_loss_cash, off) },
        { label: labels.protection.minEquity, value: shownNumber(protection.min_equity, off) },
        { label: labels.protection.maxEquityLoss, value: shownNumber(protection.max_equity_loss, off) },
        { label: labels.protection.floatingLoss, value: unitValue(protection.floating_loss_value_type, protection.floating_loss_percent, protection.floating_loss, off) },
        { label: labels.protection.giveback, value: shownNumber(protection.floating_profit_giveback, off) },
        { label: labels.protection.profitLock, value: shownNumber(protection.profit_target_lock, off) },
        { label: labels.protection.dailyProfit, value: shownNumber(protection.daily_profit_target, off) },
        { label: labels.protection.consecutiveLosses, value: shownNumber(protection.max_consecutive_losses, off) },
      ],
    },
    {
      title: labels.sections.exposure,
      rows: [
        { label: labels.exposure.maxPositions, value: shownNumber(exposure.max_open_positions, off) },
        { label: labels.exposure.maxLots, value: shownNumber(exposure.max_total_lots, off) },
        { label: labels.exposure.maxPositionsSymbol, value: shownNumber(exposure.max_positions_per_symbol, off) },
        { label: labels.exposure.maxLotsSymbol, value: shownNumber(exposure.max_lots_per_symbol, off) },
        { label: labels.exposure.maxSameDirection, value: shownNumber(exposure.max_same_direction, off) },
        { label: labels.exposure.maxPending, value: shownNumber(exposure.max_pending_orders, off) },
        { label: labels.exposure.maxOrderVolume, value: shownNumber(exposure.max_order_volume, off) },
        { label: labels.exposure.maxMarginPercent, value: shownNumber(exposure.max_margin_used_percent, off) },
        { label: labels.exposure.minFreeMargin, value: shownNumber(exposure.min_free_margin, off) },
        { label: labels.exposure.maxMarginOrder, value: shownNumber(exposure.max_margin_per_order, off) },
        { label: labels.exposure.maxStopRisk, value: shownNumber(exposure.max_aggregate_stop_risk, off) },
        { label: labels.exposure.maxStopRiskSymbol, value: shownNumber(exposure.max_stop_risk_per_symbol, off) },
        { label: labels.exposure.maxStopRiskProvider, value: shownNumber(exposure.max_stop_risk_per_provider, off) },
      ],
    },
    {
      title: labels.sections.filters,
      rows: [
        { label: labels.filters.direction, value: labels.directions[filters.direction] },
        { label: labels.filters.orderType, value: filters.order_types.map(type => labels.orderTypes[type]).join(', ') || off },
        { label: labels.filters.minVolume, value: shownNumber(filters.min_source_volume, off) },
        { label: labels.filters.maxVolume, value: shownNumber(filters.max_source_volume, off) },
        { label: labels.filters.maxSpread, value: shownNumber(filters.max_spread_points, off) },
        { label: labels.filters.maxDeviation, value: shownNumber(filters.max_entry_deviation_points, off) },
        { label: labels.filters.maxPriceMove, value: shownNumber(filters.max_price_move_points, off) },
        { label: labels.filters.maxAge, value: shownNumber(filters.max_signal_age_seconds, off) },
        { label: labels.filters.maxPositionAge, value: shownNumber(filters.max_source_position_age_seconds, off) },
        { label: labels.filters.requireStop, value: onOff(filters.require_stop, labels) },
        { label: labels.filters.minRr, value: shownNumber(filters.min_reward_risk, off) },
        { label: labels.filters.maxCopies, value: shownNumber(filters.max_copies_per_period, off) },
        { label: labels.filters.minGap, value: shownNumber(filters.min_seconds_between_copies, off) },
      ],
    },
    {
      title: labels.sections.execution,
      rows: [
        { label: labels.execution.maxDeviation, value: shownNumber(execution.max_deviation_points, off) },
        { label: labels.execution.maxLatency, value: shownNumber(execution.max_latency_seconds, off) },
        { label: labels.execution.maxSpread, value: shownNumber(execution.max_spread_points, off) },
        { label: labels.execution.rejectMargin, value: onOff(execution.reject_insufficient_margin, labels) },
        { label: labels.execution.retryLimit, value: String(execution.retry_limit) },
        { label: labels.execution.retryDeadline, value: shownNumber(execution.retry_deadline_seconds, off) },
        { label: labels.execution.failurePause, value: shownNumber(execution.failure_pause_after, off) },
        { label: labels.execution.slippagePause, value: shownNumber(execution.slippage_pause_after, off) },
        { label: labels.execution.maxSnapshotAge, value: shownNumber(execution.max_snapshot_age_seconds, off) },
      ],
    },
    {
      title: labels.sections.provider,
      rows: [
        { label: labels.provider.allocation, value: shownNumber(provider.allocation_percent, off) },
        { label: labels.provider.maxLoss, value: shownNumber(provider.max_loss, off) },
        { label: labels.provider.maxDrawdown, value: shownNumber(provider.max_drawdown_percent, off) },
        { label: labels.provider.maxPositions, value: shownNumber(provider.max_open_positions, off) },
        { label: labels.provider.maxLots, value: shownNumber(provider.max_lots, off) },
        { label: labels.provider.maxDailyTrades, value: shownNumber(provider.max_daily_trades, off) },
        { label: labels.provider.riskMultiplier, value: String(provider.risk_multiplier) },
        { label: labels.provider.consecutiveLosses, value: shownNumber(provider.max_consecutive_losses, off) },
        { label: labels.provider.suspended, value: onOff(provider.suspended, labels) },
      ],
    },
    {
      title: labels.sections.lifecycle,
      rows: [
        { label: labels.lifecycle.pauseNew, value: onOff(lifecycle.pause_new, labels) },
        { label: labels.lifecycle.disconnectAfter, value: shownNumber(lifecycle.disconnect_action_after_seconds, off) },
        { label: labels.lifecycle.disconnectAction, value: actionLabel(lifecycle.disconnect_action, labels) },
        { label: labels.lifecycle.maxUtilization, value: shownNumber(lifecycle.max_account_utilization_percent, off) },
        { label: labels.lifecycle.accountLock, value: onOff(lifecycle.account_locked, labels) },
      ],
    },
    {
      title: labels.sections.advanced,
      rows: [
        { label: labels.preset, value: advanced.preset ? labels.presets[advanced.preset] : labels.presets.none },
        { label: labels.advanced.autoReduce, value: onOff(advanced.auto_reduce, labels) },
        { label: labels.advanced.budget, value: shownNumber(advanced.account_risk_budget, off) },
        {
          label: labels.advanced.drawdownStep,
          value: advanced.drawdown_steps.length
            ? advanced.drawdown_steps.map(step => `${step.drawdown_percent}% → ${step.lot_multiplier}x`).join(', ')
            : off,
        },
      ],
    },
  ]
    .map(group => ({ ...group, rows: group.rows.filter(row => row.value !== off) }))
    .filter(group => group.rows.length > 0)
}

function simpleMethod(mode: CopySizingMode): SimpleMethod | null {
  if (mode === 'fixed_lot') return 'fixed_lot'
  if (mode === 'lot_multiplier') return 'risk_multiplier'
  if (mode === 'balance_ratio') return 'proportional'
  return null
}

function startsAdvanced(settings: CopyRiskSettings): boolean {
  const mode = settings.sizing.mode
  if (simpleMethod(mode) == null) return true
  return mode === 'balance_ratio' && settings.sizing.balance_multiplier !== 1
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null
}

function roundLot(value: number): number {
  return Math.max(0.01, Math.round(value * 100) / 100)
}

function estimateSlaveLot(
  settings: CopyRiskSettings,
  masterBalance: number | null,
  slaveBalance: number | null,
  masterEquity: number | null,
  slaveEquity: number | null,
): number | null {
  const sizing = settings.sizing
  if (sizing.mode === 'fixed_lot') return positive(sizing.fixed_lot) ? roundLot(sizing.fixed_lot) : null
  if (sizing.mode === 'lot_multiplier') {
    return positive(sizing.lot_multiplier) ? roundLot(EXAMPLE_LOT * sizing.lot_multiplier) : null
  }
  if (sizing.mode === 'balance_ratio') {
    if (!masterBalance || !slaveBalance || !positive(sizing.balance_multiplier)) return null
    return roundLot(EXAMPLE_LOT * (slaveBalance / masterBalance) * sizing.balance_multiplier)
  }
  if (sizing.mode === 'equity_ratio') {
    if (!masterEquity || !slaveEquity || !positive(sizing.equity_multiplier)) return null
    return roundLot(EXAMPLE_LOT * (slaveEquity / masterEquity) * sizing.equity_multiplier)
  }
  return null
}

function AccountLogo({ platform }: { platform: string }) {
  const [failed, setFailed] = useState(false)
  const normalized = platform.trim().toUpperCase()
  if (failed || (normalized !== 'MT4' && normalized !== 'MT5')) {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-[11px] font-semibold text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50">
        {normalized || 'MT'}
      </span>
    )
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-xs ring-1 ring-neutral-100 dark:bg-neutral-900 dark:ring-neutral-800">
      <img
        src={`/${normalized}.png`}
        alt=""
        aria-hidden
        className="h-7 w-7 object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  )
}

function accountRouteLabel(account: BrokerAccount): string {
  const broker = account.broker_name?.trim() || getBrokerDisplayLabel(account)
  return `${broker} ${account.platform.toUpperCase()}`
}

function SettingToggle({
  label,
  checked,
  onChange,
  safety = false,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  safety?: boolean
}) {
  return (
    <div className={clsx(
      'flex items-start justify-between gap-4 rounded-xl px-3 py-2.5',
      safety && 'bg-teal-50/70 ring-1 ring-teal-200/70 dark:bg-teal-950/20 dark:ring-teal-900',
    )}>
      <div className="flex min-w-0 items-center gap-2">
        {safety ? <ShieldCheck className="h-4 w-4 shrink-0 text-green-400 dark:text-green-400" aria-hidden /> : null}
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{label}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}

function PreviewValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <dt className="text-neutral-900 dark:text-neutral-50">{label}</dt>
      <dd className="max-w-[55%] text-right font-medium text-neutral-900 dark:text-neutral-100">{value}</dd>
    </div>
  )
}

function LiveNumber({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const focused = useRef(false)
  const [text, setText] = useState(String(value))
  useEffect(() => {
    if (!focused.current) setText(String(value))
  }, [value])
  return (
    <input
      type="number"
      min="0.01"
      step="0.01"
      value={text}
      onFocus={() => { focused.current = true }}
      onBlur={() => {
        focused.current = false
        const next = Number(text)
        if (!Number.isFinite(next) || next <= 0) setText(String(value))
      }}
      onChange={event => {
        setText(event.target.value)
        const next = Number(event.target.value)
        if (Number.isFinite(next) && next > 0) onCommit(next)
      }}
      className="w-24 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm tabular-nums text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
    />
  )
}

export function SlaveConfigureModal({
  slave,
  source,
  settings,
  labels,
  setup,
  loginLabel,
  balanceLabel,
  saveError,
  closeLabel,
  onChange,
  onClose,
}: {
  slave: BrokerAccount
  source: BrokerAccount | null
  settings: CopyRiskSettings
  labels: CopyRiskTranslations
  setup: SetupCopy
  loginLabel: string
  balanceLabel: string
  saveError: string | null
  closeLabel: string
  onChange: (next: CopyRiskSettings) => void
  onClose: () => void
}) {
  const { formatMoney } = useFormatMoney()
  const sizing = settings.sizing
  const [advanced, setAdvanced] = useState(() => startsAdvanced(settings))
  const activeSimple = simpleMethod(sizing.mode)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  const patch = (next: CopyRiskSettings) => onChange({ ...next, advanced: { ...next.advanced, preset: null } })
  const masterBalance = source ? positive(resolveBrokerTotalBalance(source)) : null
  const slaveBalance = positive(resolveBrokerTotalBalance(slave))
  const masterEquity = positive(source?.last_equity) ?? masterBalance
  const slaveEquity = positive(slave.last_equity) ?? slaveBalance
  const copiedLot = estimateSlaveLot(settings, masterBalance, slaveBalance, masterEquity, slaveEquity)
  const lotValue = copiedLot == null ? setup.estimateUnavailable : `${copiedLot.toFixed(2)} ${setup.lots}`
  const groups = previewGroups(settings, labels, setup.estimatedLot, lotValue)
  const profileLabel = sizing.mode === 'fixed_lot'
    ? `${sizing.fixed_lot.toFixed(2)} ${setup.lots}`
    : sizing.mode === 'lot_multiplier'
      ? `${sizing.lot_multiplier.toFixed(2)}x`
      : sizing.mode === 'balance_ratio' && sizing.balance_multiplier === 1
        ? setup.proportionalProfile
        : sizing.mode === 'balance_ratio'
          ? `${sizing.balance_multiplier.toFixed(2)}x`
          : labels.modes[sizing.mode]
  const simpleLotLabel = sizing.mode === 'fixed_lot'
    ? setup.fixedCopiedLot
    : sizing.mode === 'lot_multiplier'
      ? setup.copiedLot
      : setup.estimatedLot
  const selectSimple = (method: SimpleMethod) => {
    if (method === 'fixed_lot') {
      patch({ ...settings, sizing: { ...sizing, mode: 'fixed_lot' } })
      return
    }
    if (method === 'risk_multiplier') {
      patch({ ...settings, sizing: { ...sizing, mode: 'lot_multiplier' } })
      return
    }
    patch({
      ...settings,
      sizing: {
        ...sizing,
        mode: 'balance_ratio',
        balance_multiplier: sizing.mode === 'balance_ratio' ? sizing.balance_multiplier : 1,
      },
    })
  }
  const login = resolveAccountLogin(slave)
  const sourceName = source ? getBrokerDisplayLabel(source) : null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="slave-configure-title"
    >
      <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={closeLabel} onClick={onClose} />
      <div className="relative flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-3xl sm:rounded-2xl">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="slave-configure-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {interpolate(setup.title, { account: getBrokerDisplayLabel(slave) })}
              </h2>
              <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-green-500 dark:bg-teal-950/40 dark:text-teal-300">
                {setup.preview}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-neutral-900 dark:text-neutral-50">{setup.subtitle}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-900 dark:text-neutral-50">
              {sourceName ? <span>{sourceName}</span> : null}
              {slaveBalance != null ? (
                <span>{balanceLabel} <strong className="font-semibold text-neutral-900 dark:text-neutral-50">{formatMoney(slaveBalance)}</strong></span>
              ) : null}
              <span className="font-semibold text-neutral-900 dark:text-neutral-50">{slave.platform.toUpperCase()}</span>
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg p-2 text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:text-neutral-50 dark:hover:bg-neutral-800"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 sm:px-6">
          <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-4">
              {saveError ? (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{saveError}</p>
              ) : null}

              <div className="flex items-center justify-between gap-4 rounded-xl border border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{setup.advanced}</p>
                  <p className="mt-0.5 text-xs leading-5 text-neutral-900 dark:text-neutral-50">{setup.advancedHint}</p>
                </div>
                <Toggle checked={advanced} onChange={setAdvanced} />
              </div>

              <section aria-labelledby="slave-account-heading">
                <h3 id="slave-account-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{setup.slaveAccount}</h3>
                <div className="mt-2 flex items-center gap-3 rounded-xl border border-green-400 bg-teal-50/60 px-3 py-3 ring-1 ring-green-400 dark:bg-teal-950/20">
                  <AccountLogo platform={slave.platform} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{getBrokerDisplayLabel(slave)}</span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-900 dark:text-neutral-50">
                      {slave.broker_name?.trim() ? <span>{slave.broker_name.trim()}</span> : null}
                      <span>{slave.platform.toUpperCase()}</span>
                      {login ? <span>{loginLabel} {login}</span> : null}
                    </span>
                  </span>
                  <Check className="h-5 w-5 shrink-0 text-green-400 dark:text-green-400" aria-hidden />
                </div>
              </section>

              <section aria-labelledby="slave-method-heading">
                <h3 id="slave-method-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{setup.copyMethod}</h3>
                {advanced ? (
                <>
                <div className="mt-2 grid gap-1.5">
                  {MODES.map(mode => (
                    <button
                      key={mode}
                      type="button"
                      className={clsx(
                        'rounded-xl border px-3 py-2 text-start transition-colors',
                        sizing.mode === mode
                          ? 'border-green-400 bg-teal-50/60 ring-1 ring-green-400 dark:bg-teal-950/20'
                          : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700',
                      )}
                      aria-pressed={sizing.mode === mode}
                      onClick={() => patch({ ...settings, sizing: { ...sizing, mode } })}
                    >
                      <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">{labels.modes[mode]}</span>
                      <span className="mt-0.5 block text-xs leading-4 text-neutral-900 dark:text-neutral-50">{setup.modes[mode]}</span>
                    </button>
                  ))}
                </div>
                {sizing.mode === 'fixed_lot' || sizing.mode === 'stop_distance' ? (
                  <label className="mt-3 flex items-center gap-3 text-sm text-neutral-900 dark:text-neutral-50">
                    <span>{labels.sizing.fixedLot}</span>
                    <LiveNumber
                      value={sizing.fixed_lot}
                      onCommit={next => patch({ ...settings, sizing: { ...sizing, fixed_lot: next } })}
                    />
                    <span className="text-xs text-neutral-900 dark:text-neutral-50">{setup.lots}</span>
                  </label>
                ) : null}
                {sizing.mode === 'stop_distance' ? (
                  <label className="mt-3 flex items-center gap-3 text-sm text-neutral-900 dark:text-neutral-50">
                    <span>{labels.sizing.referencePips}</span>
                    <LiveNumber
                      value={sizing.stop_distance_reference_pips}
                      onCommit={next => patch({ ...settings, sizing: { ...sizing, stop_distance_reference_pips: next } })}
                    />
                  </label>
                ) : null}
                {sizing.mode === 'lot_multiplier' || sizing.mode === 'balance_ratio' || sizing.mode === 'equity_ratio' ? (
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {MULTIPLIERS.map(value => {
                      const current = sizing.mode === 'lot_multiplier'
                        ? sizing.lot_multiplier
                        : sizing.mode === 'balance_ratio'
                          ? sizing.balance_multiplier
                          : sizing.equity_multiplier
                      return (
                        <button
                          key={value}
                          type="button"
                          className={clsx(
                            'rounded-lg border px-2 py-2 text-xs font-semibold tabular-nums',
                            current === value
                              ? 'border-green-400 bg-teal-50 text-green-500 dark:bg-teal-950/30 dark:text-teal-300'
                              : 'border-neutral-200 text-neutral-900 dark:border-neutral-800 dark:text-neutral-50',
                          )}
                          onClick={() => patch({
                            ...settings,
                            sizing: sizing.mode === 'lot_multiplier'
                              ? { ...sizing, lot_multiplier: value }
                              : sizing.mode === 'balance_ratio'
                                ? { ...sizing, balance_multiplier: value }
                                : { ...sizing, equity_multiplier: value },
                          })}
                        >
                          {value.toFixed(2)}x
                        </button>
                      )
                    })}
                  </div>
                ) : null}
                {sizing.mode === 'percent_risk' ? (
                  <label className="mt-3 flex items-center gap-3 text-sm text-neutral-900 dark:text-neutral-50">
                    <span>{labels.sizing.percentRisk}</span>
                    <LiveNumber
                      value={sizing.percent_risk}
                      onCommit={next => patch({ ...settings, sizing: { ...sizing, percent_risk: next } })}
                    />
                  </label>
                ) : null}
                {sizing.mode === 'cash_risk' ? (
                  <label className="mt-3 flex items-center gap-3 text-sm text-neutral-900 dark:text-neutral-50">
                    <span>{labels.sizing.cashRisk}</span>
                    <LiveNumber
                      value={sizing.cash_risk}
                      onCommit={next => patch({ ...settings, sizing: { ...sizing, cash_risk: next } })}
                    />
                  </label>
                ) : null}
                </>
                ) : (
                <div className="mt-2 grid gap-1.5">
                  {([
                    ['proportional', setup.proportional, setup.modes.balance_ratio],
                    ['fixed_lot', labels.modes.fixed_lot, setup.modes.fixed_lot],
                    ['risk_multiplier', setup.riskMultiplier, setup.modes.lot_multiplier],
                  ] as const).map(([method, label, description]) => (
                    <button
                      key={method}
                      type="button"
                      className={clsx(
                        'rounded-xl border px-3 py-2 text-start transition-colors',
                        activeSimple === method
                          ? 'border-green-400 bg-teal-50/60 ring-1 ring-green-400 dark:bg-teal-950/20'
                          : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700',
                      )}
                      aria-pressed={activeSimple === method}
                      onClick={() => selectSimple(method)}
                    >
                      <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">{label}</span>
                      <span className="mt-0.5 block text-xs leading-4 text-neutral-900 dark:text-neutral-50">{description}</span>
                    </button>
                  ))}
                  {activeSimple === 'fixed_lot' ? (
                    <label className="mt-1.5 flex items-center gap-3 text-sm text-neutral-900 dark:text-neutral-50">
                      <span>{labels.sizing.fixedLot}</span>
                      <LiveNumber
                        value={sizing.fixed_lot}
                        onCommit={next => patch({ ...settings, sizing: { ...sizing, fixed_lot: next } })}
                      />
                      <span className="text-xs text-neutral-900 dark:text-neutral-50">{setup.lots}</span>
                    </label>
                  ) : null}
                  {activeSimple === 'risk_multiplier' ? (
                    <div className="mt-1.5 grid grid-cols-3 gap-2 sm:grid-cols-6">
                      {MULTIPLIERS.map(value => (
                        <button
                          key={value}
                          type="button"
                          className={clsx(
                            'rounded-lg border px-2 py-2 text-xs font-semibold tabular-nums',
                            sizing.lot_multiplier === value
                              ? 'border-green-400 bg-teal-50 text-green-500 dark:bg-teal-950/30 dark:text-teal-300'
                              : 'border-neutral-200 text-neutral-900 dark:border-neutral-800 dark:text-neutral-50',
                          )}
                          onClick={() => patch({ ...settings, sizing: { ...sizing, mode: 'lot_multiplier', lot_multiplier: value } })}
                        >
                          {value.toFixed(2)}x
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                )}
              </section>

              <section aria-labelledby="slave-protection-heading">
                <h3 id="slave-protection-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{setup.protections}</h3>
                <div className="mt-2 space-y-0.5">
                  <SettingToggle
                    label={labels.stops.copySl}
                    checked={settings.stops.copy_source_sl}
                    onChange={checked => patch({ ...settings, stops: { ...settings.stops, copy_source_sl: checked } })}
                  />
                  <SettingToggle
                    label={labels.stops.copyTp}
                    checked={settings.stops.copy_source_tp}
                    onChange={checked => patch({ ...settings, stops: { ...settings.stops, copy_source_tp: checked } })}
                  />
                  <SettingToggle
                    label={labels.stops.closeOnExit}
                    checked={settings.stops.close_on_source_exit}
                    onChange={checked => patch({ ...settings, stops: { ...settings.stops, close_on_source_exit: checked } })}
                  />
                  <SettingToggle
                    label={labels.protection.recovery}
                    checked={settings.protection.recovery_mode}
                    onChange={checked => patch({ ...settings, protection: { ...settings.protection, recovery_mode: checked } })}
                    safety
                  />
                </div>
              </section>

              {advanced ? (
                <div className="rounded-xl border border-neutral-200 px-3 py-3 dark:border-neutral-800">
                  <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{setup.moreSettings}</p>
                  <div className="mt-3">
                    <CopyRiskEditor
                      settings={settings}
                      labels={labels}
                      saveError={null}
                      currency={slave.last_currency}
                      omitSizing
                      onChange={onChange}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            <section aria-labelledby="slave-preview-heading" className="self-start rounded-2xl border border-neutral-200/80 bg-neutral-50/70 p-4 dark:border-neutral-800 dark:bg-neutral-900/60 sm:p-5 lg:sticky lg:top-0 lg:max-h-[calc(94vh-9rem)] lg:overflow-y-auto">
              <div className="flex items-center justify-between gap-3">
                <h3 id="slave-preview-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{setup.preview}</h3>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-green-500 dark:text-teal-300">{setup.preview}</span>
              </div>
              <div className="mt-4">
                <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-900 dark:text-neutral-50">{setup.exampleTrade}</p>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{sourceName ?? setup.exampleTrade}</p>
                    <p className="text-xs font-semibold text-green-500 dark:text-teal-300">{setup.masterSize}: {EXAMPLE_LOT.toFixed(2)}</p>
                  </div>
                </div>
                <div className="flex justify-center py-2 text-green-400 dark:text-green-400"><ArrowDown className="h-5 w-5" aria-hidden /></div>
                <div className="rounded-xl border border-teal-200 bg-white p-4 dark:border-teal-900 dark:bg-neutral-950">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-green-500 dark:text-teal-300">{setup.slaveAccount}</p>
                  <div className="mt-2 flex items-center gap-3">
                    <AccountLogo platform={slave.platform} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{accountRouteLabel(slave)}</p>
                      {login ? <p className="truncate text-xs text-neutral-900 dark:text-neutral-50">{loginLabel} {login}</p> : null}
                    </div>
                  </div>
                  {advanced ? (
                    <div className="mt-4 space-y-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                      {groups.map(group => (
                        <div key={group.title}>
                          <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-900 dark:text-neutral-50">{group.title}</p>
                          <dl className="mt-2 space-y-2">
                            {group.rows.map(row => (
                              <PreviewValue key={`${group.title}-${row.label}`} label={row.label} value={row.value} />
                            ))}
                          </dl>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <dl className="mt-4 space-y-2 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                      <PreviewValue label={simpleLotLabel} value={lotValue} />
                      {settings.stops.copy_source_sl ? <PreviewValue label={labels.stops.copySl} value={setup.copied} /> : null}
                      {settings.stops.copy_source_tp ? <PreviewValue label={labels.stops.copyTp} value={setup.copied} /> : null}
                      {settings.stops.close_on_source_exit ? <PreviewValue label={labels.stops.closeOnExit} value={setup.copied} /> : null}
                      <PreviewValue label={setup.riskProfile} value={profileLabel} />
                    </dl>
                  )}
                </div>
                {sourceName ? (
                  <div className="mt-3 flex items-center justify-center gap-2 text-xs font-medium text-neutral-900 dark:text-neutral-50">
                    <span className="truncate">{sourceName}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-green-400 dark:text-green-400" aria-hidden />
                    <span className="truncate">{accountRouteLabel(slave)}</span>
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </div>

        <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-neutral-100 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950 sm:flex-row sm:justify-end sm:px-6">
          <Button type="button" variant="secondary" onClick={onClose}>{closeLabel}</Button>
          <Button type="button" onClick={onClose}>{setup.done}</Button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
