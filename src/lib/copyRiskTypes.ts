export type CopySizingMode =
  | 'fixed_lot'
  | 'lot_multiplier'
  | 'balance_ratio'
  | 'equity_ratio'
  | 'percent_risk'
  | 'cash_risk'
  | 'stop_distance'

export type CopyProtectionAction = 'pause' | 'close' | 'close_and_pause'

export type CopyDrawdownValueType = 'off' | 'percent' | 'cash'

export type CopyDirectionFilter = 'both' | 'buy' | 'sell'

export type CopyOrderType = 'market' | 'limit' | 'stop'

export type CopyRiskPreset = 'conservative' | 'balanced' | 'aggressive'

export interface CopySymbolLotOverride {
  symbol: string
  fixed_lot: number
}

export interface CopyDrawdownStep {
  drawdown_percent: number
  lot_multiplier: number
}

export interface CopyRiskSizing {
  mode: CopySizingMode
  fixed_lot: number
  /** Multiplies source volume. This is not the provider risk multiplier. */
  lot_multiplier: number
  balance_multiplier: number
  equity_multiplier: number
  /** Percent of equity risked if the stop is hit. */
  percent_risk: number
  /** Cash risked if the stop is hit, in account currency. */
  cash_risk: number
  /** Lot equals fixed_lot when the stop distance matches this many pips. */
  stop_distance_reference_pips: number
  min_lot: number
  max_lot: number | null
  symbol_overrides: CopySymbolLotOverride[]
}

export interface CopyRiskProtection {
  /** Only the selected unit is enforced. The other value is kept for when the user switches back. */
  drawdown_value_type: CopyDrawdownValueType
  max_drawdown_percent: number | null
  max_drawdown_cash: number | null
  daily_loss_value_type: CopyDrawdownValueType
  max_daily_loss_percent: number | null
  max_daily_loss_cash: number | null
  weekly_loss_value_type: CopyDrawdownValueType
  max_weekly_loss_percent: number | null
  max_weekly_loss_cash: number | null
  monthly_loss_value_type: CopyDrawdownValueType
  max_monthly_loss_percent: number | null
  max_monthly_loss_cash: number | null
  min_equity: number | null
  max_equity_loss: number | null
  floating_loss_value_type: CopyDrawdownValueType
  floating_loss: number | null
  floating_loss_percent: number | null
  floating_profit_giveback: number | null
  profit_target_lock: number | null
  daily_profit_target: number | null
  max_consecutive_losses: number | null
  recovery_mode: boolean
  action: CopyProtectionAction
  emergency_stop: boolean
}

export interface CopyRiskExposure {
  max_open_positions: number | null
  max_total_lots: number | null
  max_positions_per_symbol: number | null
  max_lots_per_symbol: number | null
  max_same_direction: number | null
  max_pending_orders: number | null
  max_order_volume: number | null
  max_margin_used_percent: number | null
  min_free_margin: number | null
  max_margin_per_order: number | null
  max_aggregate_stop_risk: number | null
  max_stop_risk_per_symbol: number | null
  max_stop_risk_per_provider: number | null
}

export interface CopyRiskStops {
  copy_source_sl: boolean
  copy_source_tp: boolean
  force_sl: boolean
  force_tp: boolean
  fixed_sl_pips: number | null
  fixed_tp_pips: number | null
  sl_multiplier: number
  tp_multiplier: number
  sl_offset_pips: number
  tp_offset_pips: number
  min_sl_pips: number | null
  max_sl_pips: number | null
  min_rr: number | null
  max_rr: number | null
  never_widen_sl: boolean
  close_on_source_exit: boolean
  max_sl_modifications: number | null
}

export interface CopyRiskFilters {
  direction: CopyDirectionFilter
  order_types: CopyOrderType[]
  min_source_volume: number | null
  max_source_volume: number | null
  max_spread_points: number | null
  max_entry_deviation_points: number | null
  max_price_move_points: number | null
  max_signal_age_seconds: number | null
  max_source_position_age_seconds: number | null
  require_stop: boolean
  min_reward_risk: number | null
  max_copies_per_period: number | null
  min_seconds_between_copies: number | null
}

export interface CopyRiskExecution {
  max_deviation_points: number | null
  max_latency_seconds: number | null
  max_spread_points: number | null
  reject_insufficient_margin: boolean
  retry_limit: number
  retry_deadline_seconds: number | null
  failure_pause_after: number | null
  slippage_pause_after: number | null
  max_snapshot_age_seconds: number | null
}

export interface CopyRiskProvider {
  /** Share of the account risk budget this provider may use. */
  allocation_percent: number | null
  max_loss: number | null
  max_drawdown_percent: number | null
  max_open_positions: number | null
  max_lots: number | null
  max_daily_trades: number | null
  /** Scales monetary risk, or volume once, depending on the sizing mode. */
  risk_multiplier: number
  max_consecutive_losses: number | null
  suspended: boolean
}

export interface CopyRiskAdvanced {
  preset: CopyRiskPreset | null
  drawdown_steps: CopyDrawdownStep[]
  auto_reduce: boolean
  account_risk_budget: number | null
}

export interface CopyRiskLifecycle {
  pause_new: boolean
  disconnect_action_after_seconds: number | null
  disconnect_action: CopyProtectionAction
  max_account_utilization_percent: number | null
  account_locked: boolean
}

export interface CopyRiskSettings {
  sizing: CopyRiskSizing
  protection: CopyRiskProtection
  exposure: CopyRiskExposure
  stops: CopyRiskStops
  filters: CopyRiskFilters
  execution: CopyRiskExecution
  provider: CopyRiskProvider
  advanced: CopyRiskAdvanced
  lifecycle: CopyRiskLifecycle
}

const SIZING_MODES: CopySizingMode[] = [
  'fixed_lot',
  'lot_multiplier',
  'balance_ratio',
  'equity_ratio',
  'percent_risk',
  'cash_risk',
  'stop_distance',
]

const PROTECTION_ACTIONS: CopyProtectionAction[] = ['pause', 'close', 'close_and_pause']
const DIRECTIONS: CopyDirectionFilter[] = ['both', 'buy', 'sell']
const ORDER_TYPES: CopyOrderType[] = ['market', 'limit', 'stop']
const PRESETS: CopyRiskPreset[] = ['conservative', 'balanced', 'aggressive']

export const DEFAULT_COPY_RISK: CopyRiskSettings = {
  sizing: {
    mode: 'fixed_lot',
    fixed_lot: 0.01,
    lot_multiplier: 1,
    balance_multiplier: 1,
    equity_multiplier: 1,
    percent_risk: 1,
    cash_risk: 20,
    stop_distance_reference_pips: 20,
    min_lot: 0.01,
    max_lot: null,
    symbol_overrides: [],
  },
  protection: {
    drawdown_value_type: 'off',
    max_drawdown_percent: null,
    max_drawdown_cash: null,
    daily_loss_value_type: 'off',
    max_daily_loss_percent: null,
    max_daily_loss_cash: null,
    weekly_loss_value_type: 'off',
    max_weekly_loss_percent: null,
    max_weekly_loss_cash: null,
    monthly_loss_value_type: 'off',
    max_monthly_loss_percent: null,
    max_monthly_loss_cash: null,
    min_equity: null,
    max_equity_loss: null,
    floating_loss_value_type: 'off',
    floating_loss: null,
    floating_loss_percent: null,
    floating_profit_giveback: null,
    profit_target_lock: null,
    daily_profit_target: null,
    max_consecutive_losses: null,
    recovery_mode: false,
    action: 'pause',
    emergency_stop: false,
  },
  exposure: {
    max_open_positions: null,
    max_total_lots: null,
    max_positions_per_symbol: null,
    max_lots_per_symbol: null,
    max_same_direction: null,
    max_pending_orders: null,
    max_order_volume: null,
    max_margin_used_percent: null,
    min_free_margin: null,
    max_margin_per_order: null,
    max_aggregate_stop_risk: null,
    max_stop_risk_per_symbol: null,
    max_stop_risk_per_provider: null,
  },
  stops: {
    copy_source_sl: true,
    copy_source_tp: true,
    force_sl: false,
    force_tp: false,
    fixed_sl_pips: null,
    fixed_tp_pips: null,
    sl_multiplier: 1,
    tp_multiplier: 1,
    sl_offset_pips: 0,
    tp_offset_pips: 0,
    min_sl_pips: null,
    max_sl_pips: null,
    min_rr: null,
    max_rr: null,
    never_widen_sl: false,
    close_on_source_exit: true,
    max_sl_modifications: null,
  },
  filters: {
    direction: 'both',
    order_types: ['market'],
    min_source_volume: null,
    max_source_volume: null,
    max_spread_points: null,
    max_entry_deviation_points: null,
    max_price_move_points: null,
    max_signal_age_seconds: null,
    max_source_position_age_seconds: null,
    require_stop: false,
    min_reward_risk: null,
    max_copies_per_period: null,
    min_seconds_between_copies: null,
  },
  execution: {
    max_deviation_points: null,
    max_latency_seconds: null,
    max_spread_points: null,
    reject_insufficient_margin: true,
    retry_limit: 1,
    retry_deadline_seconds: null,
    failure_pause_after: null,
    slippage_pause_after: null,
    max_snapshot_age_seconds: null,
  },
  provider: {
    allocation_percent: null,
    max_loss: null,
    max_drawdown_percent: null,
    max_open_positions: null,
    max_lots: null,
    max_daily_trades: null,
    risk_multiplier: 1,
    max_consecutive_losses: null,
    suspended: false,
  },
  advanced: {
    preset: null,
    drawdown_steps: [],
    auto_reduce: false,
    account_risk_budget: null,
  },
  lifecycle: {
    pause_new: false,
    disconnect_action_after_seconds: null,
    disconnect_action: 'pause',
    max_account_utilization_percent: null,
    account_locked: false,
  },
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function positive(value: unknown): number | null {
  const n = finite(value)
  return n != null && n > 0 ? n : null
}

function nonNegative(value: unknown, fallback: number): number {
  const n = finite(value)
  return n != null && n >= 0 ? n : fallback
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function optionalCap(value: unknown): number | null {
  return positive(value)
}

function valueType(raw: unknown, cash: number | null, percent: number | null): CopyDrawdownValueType {
  if (raw === 'off' || raw === 'cash' || raw === 'percent') return raw
  if (cash != null && percent == null) return 'cash'
  if (percent != null) return 'percent'
  return 'off'
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function normalizeCopyRisk(raw: unknown): CopyRiskSettings {
  const root = objectOf(raw)
  const sizing = objectOf(root.sizing)
  const protection = objectOf(root.protection)
  const exposure = objectOf(root.exposure)
  const stops = objectOf(root.stops)
  const filters = objectOf(root.filters)
  const execution = objectOf(root.execution)
  const provider = objectOf(root.provider)
  const advanced = objectOf(root.advanced)
  const lifecycle = objectOf(root.lifecycle)
  const base = DEFAULT_COPY_RISK

  const overrides = Array.isArray(sizing.symbol_overrides)
    ? sizing.symbol_overrides.flatMap(row => {
        const item = objectOf(row)
        const symbol = String(item.symbol ?? '').trim()
        const lot = positive(item.fixed_lot)
        if (lot == null) return []
        return [{ symbol, fixed_lot: lot }]
      })
    : []

  const steps = Array.isArray(advanced.drawdown_steps)
    ? advanced.drawdown_steps.flatMap(row => {
        const item = objectOf(row)
        const drawdown = positive(item.drawdown_percent)
        const multiplier = finite(item.lot_multiplier)
        if (drawdown == null || multiplier == null || multiplier < 0) return []
        return [{ drawdown_percent: drawdown, lot_multiplier: multiplier }]
      })
    : []

  const orderTypes = Array.isArray(filters.order_types)
    ? filters.order_types.filter((item): item is CopyOrderType => ORDER_TYPES.includes(item as CopyOrderType))
    : base.filters.order_types

  return {
    sizing: {
      mode: pick(sizing.mode, SIZING_MODES, base.sizing.mode),
      fixed_lot: positive(sizing.fixed_lot) ?? base.sizing.fixed_lot,
      lot_multiplier: nonNegative(sizing.lot_multiplier, base.sizing.lot_multiplier),
      balance_multiplier: nonNegative(sizing.balance_multiplier, base.sizing.balance_multiplier),
      equity_multiplier: nonNegative(sizing.equity_multiplier, base.sizing.equity_multiplier),
      percent_risk: nonNegative(sizing.percent_risk, base.sizing.percent_risk),
      cash_risk: nonNegative(sizing.cash_risk, base.sizing.cash_risk),
      stop_distance_reference_pips: positive(sizing.stop_distance_reference_pips) ?? base.sizing.stop_distance_reference_pips,
      min_lot: positive(sizing.min_lot) ?? base.sizing.min_lot,
      max_lot: optionalCap(sizing.max_lot),
      symbol_overrides: overrides,
    },
    protection: (() => {
      const maxDrawdownPercent = optionalCap(protection.max_drawdown_percent)
      const maxDrawdownCash = optionalCap(protection.max_drawdown_cash)
      const dailyPercent = optionalCap(protection.max_daily_loss_percent)
      const dailyCash = optionalCap(protection.max_daily_loss_cash)
      const weeklyPercent = optionalCap(protection.max_weekly_loss_percent)
      const weeklyCash = optionalCap(protection.max_weekly_loss_cash)
      const monthlyPercent = optionalCap(protection.max_monthly_loss_percent)
      const monthlyCash = optionalCap(protection.max_monthly_loss_cash)
      const floatingCash = optionalCap(protection.floating_loss)
      const floatingPercent = optionalCap(protection.floating_loss_percent)
      return {
      drawdown_value_type: valueType(protection.drawdown_value_type, maxDrawdownCash, maxDrawdownPercent),
      max_drawdown_percent: maxDrawdownPercent,
      max_drawdown_cash: maxDrawdownCash,
      daily_loss_value_type: valueType(protection.daily_loss_value_type, dailyCash, dailyPercent),
      max_daily_loss_percent: dailyPercent,
      max_daily_loss_cash: dailyCash,
      weekly_loss_value_type: valueType(protection.weekly_loss_value_type, weeklyCash, weeklyPercent),
      max_weekly_loss_percent: weeklyPercent,
      max_weekly_loss_cash: weeklyCash,
      monthly_loss_value_type: valueType(protection.monthly_loss_value_type, monthlyCash, monthlyPercent),
      max_monthly_loss_percent: monthlyPercent,
      max_monthly_loss_cash: monthlyCash,
      min_equity: optionalCap(protection.min_equity),
      max_equity_loss: optionalCap(protection.max_equity_loss),
      floating_loss_value_type: valueType(protection.floating_loss_value_type, floatingCash, floatingPercent),
      floating_loss: floatingCash,
      floating_loss_percent: floatingPercent,
      floating_profit_giveback: optionalCap(protection.floating_profit_giveback),
      profit_target_lock: optionalCap(protection.profit_target_lock),
      daily_profit_target: optionalCap(protection.daily_profit_target),
      max_consecutive_losses: optionalCap(protection.max_consecutive_losses),
      recovery_mode: protection.recovery_mode === true,
      action: pick(protection.action, PROTECTION_ACTIONS, base.protection.action),
      emergency_stop: protection.emergency_stop === true,
      }
    })(),
    exposure: {
      max_open_positions: optionalCap(exposure.max_open_positions),
      max_total_lots: optionalCap(exposure.max_total_lots),
      max_positions_per_symbol: optionalCap(exposure.max_positions_per_symbol),
      max_lots_per_symbol: optionalCap(exposure.max_lots_per_symbol),
      max_same_direction: optionalCap(exposure.max_same_direction),
      max_pending_orders: optionalCap(exposure.max_pending_orders),
      max_order_volume: optionalCap(exposure.max_order_volume),
      max_margin_used_percent: optionalCap(exposure.max_margin_used_percent),
      min_free_margin: optionalCap(exposure.min_free_margin),
      max_margin_per_order: optionalCap(exposure.max_margin_per_order),
      max_aggregate_stop_risk: optionalCap(exposure.max_aggregate_stop_risk),
      max_stop_risk_per_symbol: optionalCap(exposure.max_stop_risk_per_symbol),
      max_stop_risk_per_provider: optionalCap(exposure.max_stop_risk_per_provider),
    },
    stops: {
      copy_source_sl: stops.copy_source_sl !== false,
      copy_source_tp: stops.copy_source_tp !== false,
      force_sl: stops.force_sl === true,
      force_tp: stops.force_tp === true,
      fixed_sl_pips: optionalCap(stops.fixed_sl_pips),
      fixed_tp_pips: optionalCap(stops.fixed_tp_pips),
      sl_multiplier: nonNegative(stops.sl_multiplier, 1),
      tp_multiplier: nonNegative(stops.tp_multiplier, 1),
      sl_offset_pips: finite(stops.sl_offset_pips) ?? 0,
      tp_offset_pips: finite(stops.tp_offset_pips) ?? 0,
      min_sl_pips: optionalCap(stops.min_sl_pips),
      max_sl_pips: optionalCap(stops.max_sl_pips),
      min_rr: optionalCap(stops.min_rr),
      max_rr: optionalCap(stops.max_rr),
      never_widen_sl: stops.never_widen_sl === true,
      close_on_source_exit: stops.close_on_source_exit !== false,
      max_sl_modifications: optionalCap(stops.max_sl_modifications),
    },
    filters: {
      direction: pick(filters.direction, DIRECTIONS, 'both'),
      order_types: orderTypes.length > 0 ? orderTypes : ['market'],
      min_source_volume: optionalCap(filters.min_source_volume),
      max_source_volume: optionalCap(filters.max_source_volume),
      max_spread_points: optionalCap(filters.max_spread_points),
      max_entry_deviation_points: optionalCap(filters.max_entry_deviation_points),
      max_price_move_points: optionalCap(filters.max_price_move_points),
      max_signal_age_seconds: optionalCap(filters.max_signal_age_seconds),
      max_source_position_age_seconds: optionalCap(filters.max_source_position_age_seconds),
      require_stop: filters.require_stop === true,
      min_reward_risk: optionalCap(filters.min_reward_risk),
      max_copies_per_period: optionalCap(filters.max_copies_per_period),
      min_seconds_between_copies: optionalCap(filters.min_seconds_between_copies),
    },
    execution: {
      max_deviation_points: optionalCap(execution.max_deviation_points),
      max_latency_seconds: optionalCap(execution.max_latency_seconds),
      max_spread_points: optionalCap(execution.max_spread_points),
      reject_insufficient_margin: execution.reject_insufficient_margin !== false,
      retry_limit: Math.max(0, Math.floor(finite(execution.retry_limit) ?? base.execution.retry_limit)),
      retry_deadline_seconds: optionalCap(execution.retry_deadline_seconds),
      failure_pause_after: optionalCap(execution.failure_pause_after),
      slippage_pause_after: optionalCap(execution.slippage_pause_after),
      max_snapshot_age_seconds: optionalCap(execution.max_snapshot_age_seconds),
    },
    provider: {
      allocation_percent: optionalCap(provider.allocation_percent),
      max_loss: optionalCap(provider.max_loss),
      max_drawdown_percent: optionalCap(provider.max_drawdown_percent),
      max_open_positions: optionalCap(provider.max_open_positions),
      max_lots: optionalCap(provider.max_lots),
      max_daily_trades: optionalCap(provider.max_daily_trades),
      risk_multiplier: nonNegative(provider.risk_multiplier, 1),
      max_consecutive_losses: optionalCap(provider.max_consecutive_losses),
      suspended: provider.suspended === true,
    },
    advanced: {
      preset: PRESETS.includes(advanced.preset as CopyRiskPreset) ? (advanced.preset as CopyRiskPreset) : null,
      drawdown_steps: steps,
      auto_reduce: advanced.auto_reduce === true,
      account_risk_budget: optionalCap(advanced.account_risk_budget),
    },
    lifecycle: {
      pause_new: lifecycle.pause_new === true,
      disconnect_action_after_seconds: optionalCap(lifecycle.disconnect_action_after_seconds),
      disconnect_action: pick(lifecycle.disconnect_action, PROTECTION_ACTIONS, 'pause'),
      max_account_utilization_percent: optionalCap(lifecycle.max_account_utilization_percent),
      account_locked: lifecycle.account_locked === true,
    },
  }
}

function withPreset(
  preset: CopyRiskPreset,
  patch: Partial<{
    maxLot: number
    drawdown: number
    dailyLoss: number
    positions: number
    lots: number
    margin: number
    action: CopyProtectionAction
    autoReduce: boolean
    multiplier: number
    mode: CopySizingMode
  }>,
): CopyRiskSettings {
  const next = normalizeCopyRisk({
    ...DEFAULT_COPY_RISK,
    sizing: {
      ...DEFAULT_COPY_RISK.sizing,
      mode: patch.mode ?? 'fixed_lot',
      lot_multiplier: patch.multiplier ?? 1,
      max_lot: patch.maxLot ?? null,
    },
    protection: {
      ...DEFAULT_COPY_RISK.protection,
      drawdown_value_type: patch.drawdown != null ? 'percent' : 'off',
      max_drawdown_percent: patch.drawdown ?? null,
      daily_loss_value_type: patch.dailyLoss != null ? 'percent' : 'off',
      max_daily_loss_percent: patch.dailyLoss ?? null,
      action: patch.action ?? 'pause',
    },
    exposure: {
      ...DEFAULT_COPY_RISK.exposure,
      max_open_positions: patch.positions ?? null,
      max_total_lots: patch.lots ?? null,
      max_margin_used_percent: patch.margin ?? null,
    },
    stops: {
      ...DEFAULT_COPY_RISK.stops,
      never_widen_sl: true,
    },
    filters: {
      ...DEFAULT_COPY_RISK.filters,
      require_stop: true,
      max_spread_points: preset === 'conservative' ? 15 : preset === 'balanced' ? 30 : 50,
    },
    advanced: {
      ...DEFAULT_COPY_RISK.advanced,
      preset,
      auto_reduce: patch.autoReduce ?? false,
    },
    lifecycle: {
      ...DEFAULT_COPY_RISK.lifecycle,
      max_account_utilization_percent: patch.margin ?? null,
    },
  })
  return next
}

/** Writes the first-slice fields for a named preset. The user can edit afterward. */
export function applyCopyRiskPreset(preset: CopyRiskPreset): CopyRiskSettings {
  if (preset === 'conservative') {
    return withPreset(preset, {
      maxLot: 0.1,
      drawdown: 5,
      dailyLoss: 2,
      positions: 3,
      lots: 0.5,
      margin: 20,
      action: 'close_and_pause',
      autoReduce: true,
      mode: 'fixed_lot',
    })
  }
  if (preset === 'aggressive') {
    return withPreset(preset, {
      maxLot: 5,
      drawdown: 20,
      dailyLoss: 10,
      positions: 30,
      lots: 20,
      margin: 70,
      action: 'pause',
      autoReduce: false,
      mode: 'lot_multiplier',
      multiplier: 1,
    })
  }
  return withPreset(preset, {
    maxLot: 1,
    drawdown: 10,
    dailyLoss: 5,
    positions: 10,
    lots: 5,
    margin: 40,
    action: 'pause',
    autoReduce: true,
    mode: 'lot_multiplier',
    multiplier: 1,
  })
}

/** Keeps the legacy risk columns in sync when a mirror link saves a copy risk profile. */
export function manualSettingsFromCopyRisk(
  risk: CopyRiskSettings,
): {
  copy_risk: CopyRiskSettings
  risk_mode: 'fixed_lot' | 'dynamic_balance_percent'
  fixed_lot: number
  dynamic_balance_percent: number
} {
  const normalized = normalizeCopyRisk(risk)
  const ratio = normalized.sizing.mode === 'balance_ratio' || normalized.sizing.mode === 'equity_ratio'
  return {
    copy_risk: normalized,
    risk_mode: ratio ? 'dynamic_balance_percent' : 'fixed_lot',
    fixed_lot: normalized.sizing.fixed_lot,
    dynamic_balance_percent: normalized.sizing.mode === 'equity_ratio'
      ? normalized.sizing.equity_multiplier
      : normalized.sizing.balance_multiplier,
  }
}

export function copyRiskForEditor(settings: {
  copy_risk?: CopyRiskSettings | null
  risk_mode?: 'fixed_lot' | 'dynamic_balance_percent'
  fixed_lot?: number
  dynamic_balance_percent?: number
}): CopyRiskSettings {
  if (settings.copy_risk) return normalizeCopyRisk(settings.copy_risk)
  const next = normalizeCopyRisk(undefined)
  next.sizing.fixed_lot = settings.fixed_lot && settings.fixed_lot > 0 ? settings.fixed_lot : next.sizing.fixed_lot
  if (settings.risk_mode === 'dynamic_balance_percent') {
    next.sizing.mode = 'balance_ratio'
    next.sizing.balance_multiplier = settings.dynamic_balance_percent && settings.dynamic_balance_percent > 0
      ? settings.dynamic_balance_percent
      : 1
  }
  return next
}

export function mirrorSizingLabel(mode: CopySizingMode): string {
  switch (mode) {
    case 'fixed_lot':
      return 'Fixed lot'
    case 'lot_multiplier':
      return 'Lot multiplier'
    case 'balance_ratio':
      return 'Balance ratio'
    case 'equity_ratio':
      return 'Equity ratio'
    case 'percent_risk':
      return 'Percent risk'
    case 'cash_risk':
      return 'Cash risk'
    case 'stop_distance':
      return 'Stop distance'
    default:
      return 'Fixed lot'
  }
}

export function mirrorSizingValue(risk: CopyRiskSettings): string {
  const sizing = risk.sizing
  switch (sizing.mode) {
    case 'fixed_lot':
      return String(sizing.fixed_lot)
    case 'lot_multiplier':
      return `${sizing.lot_multiplier}x`
    case 'balance_ratio':
      return `${sizing.balance_multiplier}x`
    case 'equity_ratio':
      return `${sizing.equity_multiplier}x`
    case 'percent_risk':
      return `${sizing.percent_risk}%`
    case 'cash_risk':
      return String(sizing.cash_risk)
    case 'stop_distance':
      return `${sizing.fixed_lot} @ ${sizing.stop_distance_reference_pips}`
    default:
      return String(sizing.fixed_lot)
  }
}
