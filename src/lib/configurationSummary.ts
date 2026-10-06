import type { ConfigureModalTranslations } from '../i18n/locales/configureModal/types'
import type { ConfigurationsPageTranslations } from '../i18n/locales/types'
import type { ManualSettings } from '../types/database'
import { DEFAULT_MANUAL_SETTINGS } from './defaultManualSettings'
import {
  estimateMultiTradeOrderCount,
  formatMultiTradeTotalOpenTradesPreview,
} from './estimateMultiTradeOrders'
import { formatPreviewLotSize, resolvePreviewManualLot } from './manualLotSizing'
import { resolveMultiTradePerLegLot } from './multiTradeLegUnits'
import { normalizeCopyLimits } from './copyLimitTypes'

export interface ConfigurationDetailRow {
  label: string
  value: string
}

export interface ConfigurationDetailSection {
  id: 'risk' | 'targets' | 'management' | 'symbols' | 'filters'
  title: string
  rows: ConfigurationDetailRow[]
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function formatSettingNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 100) / 100
  return String(rounded)
}

function onOff(value: boolean, copy: ConfigurationsPageTranslations): string {
  return value ? copy.on : copy.off
}

function symbolList(value: string | string[] | null | undefined, empty: string): string {
  const items = Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean)
    : String(value ?? '').split(',').map(item => item.trim()).filter(Boolean)
  return items.length ? items.join(', ') : empty
}

function limitSummary(
  enabled: boolean,
  rules: Array<{ period: string; value: number; value_type: string }>,
  copy: ConfigurationsPageTranslations,
): string {
  if (!enabled || rules.length === 0) return copy.off
  return rules
    .map(rule => `${rule.period} ${formatSettingNumber(rule.value)}${rule.value_type === 'percent' ? '%' : ''}`)
    .join(', ')
}

function moveSlValue(settings: ManualSettings, cm: ConfigureModalTranslations, copy: ConfigurationsPageTranslations): string {
  const mode = settings.move_sl_to_entry_after_mode ?? 'none'
  if (mode === 'none') return copy.off
  const amount = formatSettingNumber(finiteNumber(settings.move_sl_to_entry_after_value))
  if (mode === 'pips') return `${cm.management.triggerPips}: ${amount}`
  if (mode === 'rr') return `${cm.management.triggerRr}: ${amount}`
  if (mode === 'money') return `${cm.management.triggerMoney}: ${amount}`
  if (mode === 'tp_hit') {
    const index = finiteNumber(settings.move_sl_to_entry_tp_index, 1)
    return `${cm.management.triggerTpHit}: TP${index}`
  }
  return copy.off
}

/** Label/value rows for the settings saved on one broker and channel. */
export function describeChannelConfiguration(
  settings: ManualSettings | null | undefined,
  cm: ConfigureModalTranslations,
  copy: ConfigurationsPageTranslations,
  opts?: { accountBalance?: number | null },
): ConfigurationDetailSection[] {
  const row = settings ?? {}
  const rangeStyle = row.trade_style === 'multi'
  const balancePercent = row.risk_mode === 'dynamic_balance_percent'
  const manualLot = resolvePreviewManualLot({
    manualSettings: {
      risk_mode: balancePercent ? 'dynamic_balance_percent' : 'fixed_lot',
      fixed_lot: finiteNumber(row.fixed_lot, DEFAULT_MANUAL_SETTINGS.fixed_lot ?? 0.01),
      dynamic_balance_percent: finiteNumber(row.dynamic_balance_percent, 1),
    },
    accountBalance: opts?.accountBalance,
  })

  const riskRows: ConfigurationDetailRow[] = [
    {
      label: cm.risk.tradeStyle,
      value: rangeStyle ? cm.risk.multiTrades : cm.risk.singleTrade,
    },
    {
      label: cm.risk.riskMode,
      value: balancePercent ? cm.risk.dynamicBalance : cm.risk.fixedLot,
    },
  ]

  if (balancePercent) {
    riskRows.push({
      label: cm.risk.dynamicBalance,
      value: formatSettingNumber(finiteNumber(row.dynamic_balance_percent, 1)),
    })
    riskRows.push({
      label: cm.risk.dynamicBalanceLotSize,
      value: formatPreviewLotSize(manualLot),
    })
  } else {
    riskRows.push({
      label: copy.lotSize,
      value: formatSettingNumber(finiteNumber(row.fixed_lot, DEFAULT_MANUAL_SETTINGS.fixed_lot ?? 0.01)),
    })
  }

  if (rangeStyle) {
    const legPercent = finiteNumber(row.multi_trade_leg_percent, DEFAULT_MANUAL_SETTINGS.multi_trade_leg_percent ?? 5)
    const rangeOn = row.range_trading === true
    const signalRange = row.use_signal_entry_range === true
    const preview = estimateMultiTradeOrderCount({
      manualLot,
      legPercent,
      range: rangeOn
        ? {
            enabled: true,
            percent: finiteNumber(row.range_percent, DEFAULT_MANUAL_SETTINGS.range_percent ?? 50),
            stepPips: finiteNumber(row.range_step_pips),
            distancePips: finiteNumber(row.range_distance_pips, DEFAULT_MANUAL_SETTINGS.range_distance_pips ?? 30),
            useSignalEntryRange: signalRange,
          }
        : undefined,
    })
    const perLeg = resolveMultiTradePerLegLot({ manualLot, legPercent })
    riskRows.push(
      { label: cm.risk.perLegSize, value: formatSettingNumber(legPercent) },
      {
        label: cm.risk.totalOpenTrades,
        value: formatMultiTradeTotalOpenTradesPreview(perLeg, preview, {
          fallbackSingle: cm.risk.previewFallbackSingle,
          lotsXTrades: cm.risk.previewLotsXTrades,
          lotsXTradesLayered: cm.risk.previewLotsXTradesLayered,
        }, formatPreviewLotSize),
      },
      { label: cm.risk.useSignalRange, value: onOff(signalRange, copy) },
    )
    if (signalRange) {
      riskRows.push({
        label: cm.risk.useSignalRangePipTolerance,
        value: formatSettingNumber(finiteNumber(row.signal_entry_pip_tolerance, 10)),
      })
    }
    riskRows.push({ label: cm.risk.rangeLayering, value: onOff(rangeOn, copy) })
    if (rangeOn) {
      const step = finiteNumber(row.range_step_pips)
      riskRows.push(
        {
          label: copy.layeringMode,
          value: row.range_layering_type === 'pending_order' ? copy.layeringPending : copy.layeringAutomatic,
        },
        {
          label: cm.risk.reservedLot,
          value: formatSettingNumber(finiteNumber(row.range_percent, DEFAULT_MANUAL_SETTINGS.range_percent ?? 50)),
        },
        {
          label: cm.risk.stepPips,
          value: step > 0 ? formatSettingNumber(step) : cm.risk.stepModeAuto,
        },
        {
          label: cm.risk.rangeDistance,
          value: formatSettingNumber(finiteNumber(row.range_distance_pips, DEFAULT_MANUAL_SETTINGS.range_distance_pips ?? 30)),
        },
        { label: cm.risk.layerTillClose, value: onOff(row.range_layer_till_close === true, copy) },
      )
    }
  } else {
    const target = row.single_tp_target ?? 'farthest'
    riskRows.push(
      {
        label: cm.risk.singleTpTarget,
        value: target === 'farthest' ? cm.risk.singleTpTargetFarthest : target.toUpperCase(),
      },
      { label: cm.risk.useSignalEntryPrice, value: onOff(row.use_signal_entry_price === true, copy) },
    )
    if (row.use_signal_entry_price === true) {
      riskRows.push({
        label: cm.risk.pipToleranceLegacy,
        value: formatSettingNumber(finiteNumber(row.signal_entry_pip_tolerance, 10)),
      })
    }
  }

  const tpLots = row.tp_lots ?? []
  const tpShare = tpLots
    .filter(entry => entry.enabled !== false)
    .map(entry => `${entry.label?.trim() || 'TP'} ${formatSettingNumber(finiteNumber(entry.percent))}%`)
    .join(', ')
  const limits = normalizeCopyLimits(row.copy_limits)
  const targetRows: ConfigurationDetailRow[] = [
    { label: cm.stops.overrideSl, value: onOff(row.use_predefined_sl_pips === true, copy) },
  ]
  if (row.use_predefined_sl_pips === true) {
    targetRows.push({
      label: cm.stops.slPips,
      value: formatSettingNumber(finiteNumber(row.predefined_sl_pips, DEFAULT_MANUAL_SETTINGS.predefined_sl_pips ?? 30)),
    })
  }
  const predefinedTpPips = (row.predefined_tp_pips ?? []).map(value => formatSettingNumber(finiteNumber(value)))
  targetRows.push({
    label: cm.stops.overrideTps,
    value: row.use_predefined_tp_pips === true
      ? (predefinedTpPips.join(', ') || copy.on)
      : copy.off,
  })
  if (tpShare) {
    targetRows.push({ label: cm.stops.tpDistributionTitle, value: tpShare })
  }
  targetRows.push(
    {
      label: cm.stops.profitTargetsToggle,
      value: limitSummary(limits.profit_targets_enabled, limits.profit_targets, copy),
    },
    {
      label: cm.stops.maxRiskToggle,
      value: limitSummary(limits.max_risk_enabled, limits.max_risks, copy),
    },
  )

  const managementRows: ConfigurationDetailRow[] = [
    { label: cm.strategy.reverseSignal, value: onOff(row.reverse_signal === true, copy) },
    { label: cm.strategy.addToExisting, value: onOff(row.add_new_trades_to_existing !== false, copy) },
    { label: cm.strategy.closeOpposite, value: onOff(row.close_on_opposite_signal === true, copy) },
    { label: cm.management.moveSlTitle, value: moveSlValue(row, cm, copy) },
    { label: cm.management.trailingTitle, value: onOff(row.trailing_enabled === true, copy) },
    { label: cm.management.orderCommentsTitle, value: onOff(row.order_comments_enabled !== false, copy) },
  ]
  if (row.trailing_enabled === true) {
    managementRows.push(
      { label: cm.management.trailStart, value: formatSettingNumber(finiteNumber(row.trailing_start_pips, 20)) },
      { label: cm.management.trailStep, value: formatSettingNumber(finiteNumber(row.trailing_step_pips, 5)) },
      { label: cm.management.trailDistance, value: formatSettingNumber(finiteNumber(row.trailing_distance_pips, 10)) },
    )
  }

  const days = (row.trade_days ?? [])
    .map(day => cm.filters.weekdays[String(day) as keyof typeof cm.filters.weekdays])
    .filter(Boolean)
  const filterRows: ConfigurationDetailRow[] = [
    {
      label: cm.filters.timeFilter,
      value: row.time_filter_enabled
        ? `${row.trade_start_time || '00:00'}–${row.trade_end_time || '23:59'}`
        : cm.filters.timeNo,
    },
    {
      label: cm.filters.daysFilter,
      value: row.days_filter_enabled ? (days.join(', ') || copy.on) : cm.filters.daysNo,
    },
    {
      label: cm.filters.newsTrading,
      value: row.news_trading_enabled === false ? cm.filters.newsNo : cm.filters.newsYes,
    },
  ]

  return [
    { id: 'risk', title: cm.manualSubTabs.risk, rows: riskRows },
    { id: 'targets', title: cm.manualSubTabs.stops, rows: targetRows },
    { id: 'management', title: cm.manualSubTabs.management, rows: managementRows },
    {
      id: 'symbols',
      title: cm.manualSubTabs.symbols,
      rows: [
        { label: cm.channelSymbols.tradeOnlyLabel, value: symbolList(row.symbol_to_trade, copy.allSymbols) },
        { label: cm.channelSymbols.avoidLabel, value: symbolList(row.symbols_exclude, copy.none) },
      ],
    },
    { id: 'filters', title: cm.manualSubTabs.filters, rows: filterRows },
  ]
}
