import {
  normalizeCopyRisk,
  type CopyProtectionAction,
  type CopyRiskSettings,
} from './copyRiskTypes'
import {
  type CopyRiskReason,
  copyRiskLogEvent,
  type CopyRiskLogEvent,
} from './copyRiskReasons'

export type { CopyRiskLogEvent, CopyRiskReason }
export { copyRiskLogEvent }

export type CopyRiskAction = 'allow' | 'resize' | 'skip' | 'pause' | 'flatten'

export interface CopyRiskDecision {
  action: CopyRiskAction
  reason: CopyRiskReason
  lot?: number
  stopPips?: number | null
  targetPips?: number | null
  /** When action is flatten, also stop new copies. */
  pause?: boolean
  closeOnSourceExit?: boolean
}

export interface CopyRiskAccountSnapshot {
  balance: number
  equity: number
  peakEquity: number
  balanceReference: number
  dayStartEquity: number
  weekStartEquity: number
  monthStartEquity: number
  freeMargin: number
  marginUsedPercent: number
  floatingPnl: number
  floatingPeakProfit: number
  consecutiveLosses: number
  connected: boolean
  disconnectedSeconds: number
  tradingDisabled: boolean
  accountLocked: boolean
  quotesAgeSeconds: number | null
  equityAgeSeconds: number | null
  /** A previous loss limit has already fired, so sizing must not step up. */
  protectionLatched: boolean
}

export interface CopyRiskOpenPosition {
  symbol: string
  direction: 'buy' | 'sell'
  lots: number
  pending: boolean
  stopRiskCash: number | null
  providerId: string | null
}

export interface CopyRiskProviderState {
  id: string
  suspended: boolean
  allowFollowing: boolean
  balance: number | null
  equity: number | null
  loss: number
  drawdownPercent: number
  openPositions: number
  openLots: number
  dailyTrades: number
  consecutiveLosses: number
  executionFailures: number
  slippageBreaches: number
}

export interface CopyRiskTradeInput {
  ticket: string
  symbol: string
  mappedSymbol: string | null
  direction: 'buy' | 'sell'
  orderType: 'market' | 'limit' | 'stop'
  lots: number
  stopPips: number | null
  targetPips: number | null
  spreadPoints: number | null
  ageSeconds: number
  positionAgeSeconds: number
  priceMovePoints: number | null
  deviationPoints: number | null
  latencySeconds: number
  alreadyCopied: boolean
  /** Source order comment is already a copier trade. */
  isCopy: boolean
  snapshotAgeSeconds: number | null
  /** source contract size / follower contract size. Applied to volume modes only. */
  contractSizeRatio: number
  volumeStep: number
  minVolume: number
  maxVolume: number
  /** Cash per pip per 1.00 lot, in quote currency. */
  pipValuePerLot: number
  /** Converts quote-currency pip value into account currency. */
  quoteToAccountRate: number
  estimatedMargin: number | null
  secondsSinceLastCopy: number | null
  copiesInPeriod: number
  slModificationCount: number
  proposedStopWider: boolean
  existingStopPips: number | null
}

export interface CopyRiskEvaluationInput {
  risk: CopyRiskSettings | unknown
  trigger: 'trade' | 'timer'
  account: CopyRiskAccountSnapshot
  positions: CopyRiskOpenPosition[]
  trade?: CopyRiskTradeInput
  provider?: CopyRiskProviderState
  symbolsAllow?: string[] | null
  symbolsDeny?: string[]
  copyLimitBreach?: 'profit' | 'risk' | null
}

const VOLUME_MODES = new Set<CopyRiskSettings['sizing']['mode']>([
  'lot_multiplier',
  'balance_ratio',
  'equity_ratio',
])

function decision(
  action: CopyRiskAction,
  reason: CopyRiskReason,
  extra: Omit<CopyRiskDecision, 'action' | 'reason'> = {},
): CopyRiskDecision {
  return { action, reason, ...extra }
}

function protectionDecision(action: CopyProtectionAction, reason: CopyRiskReason): CopyRiskDecision {
  if (action === 'close') return decision('flatten', reason, { pause: false })
  if (action === 'close_and_pause') return decision('flatten', reason, { pause: true })
  return decision('pause', reason)
}

function lossAmount(current: number, reference: number): number {
  return Math.max(0, reference - current)
}

function lossPercent(current: number, reference: number): number {
  if (!(reference > 0)) return 0
  return (lossAmount(current, reference) / reference) * 100
}

function breached(limit: number | null, value: number): boolean {
  return limit != null && limit > 0 && value >= limit
}

function drawdownPercent(account: CopyRiskAccountSnapshot): number {
  const fromPeak = lossPercent(account.equity, account.peakEquity)
  const fromBalance = lossPercent(account.equity, account.balanceReference)
  return Math.max(fromPeak, fromBalance)
}

function drawdownCash(account: CopyRiskAccountSnapshot): number {
  return Math.max(
    lossAmount(account.equity, account.peakEquity),
    lossAmount(account.equity, account.balanceReference),
  )
}

function protectionReason(risk: CopyRiskSettings, account: CopyRiskAccountSnapshot): CopyRiskReason | null {
  const protection = risk.protection
  const ddPct = drawdownPercent(account)
  const ddCash = drawdownCash(account)
  const unitHit = (
    type: CopyRiskSettings['protection']['drawdown_value_type'],
    percentLimit: number | null,
    percentValue: number,
    cashLimit: number | null,
    cashValue: number,
  ) => {
    if (type === 'off') return false
    return type === 'cash' ? breached(cashLimit, cashValue) : breached(percentLimit, percentValue)
  }
  if (unitHit(protection.drawdown_value_type, protection.max_drawdown_percent, ddPct, protection.max_drawdown_cash, ddCash)) {
    return 'copy_risk_drawdown'
  }
  if (breached(protection.max_equity_loss, ddCash)) return 'copy_risk_equity_loss'
  if (protection.min_equity != null && account.equity < protection.min_equity) return 'copy_risk_min_equity'
  if (unitHit(
    protection.daily_loss_value_type,
    protection.max_daily_loss_percent,
    lossPercent(account.equity, account.dayStartEquity),
    protection.max_daily_loss_cash,
    lossAmount(account.equity, account.dayStartEquity),
  )) return 'copy_risk_daily_loss'
  if (unitHit(
    protection.weekly_loss_value_type,
    protection.max_weekly_loss_percent,
    lossPercent(account.equity, account.weekStartEquity),
    protection.max_weekly_loss_cash,
    lossAmount(account.equity, account.weekStartEquity),
  )) return 'copy_risk_weekly_loss'
  if (unitHit(
    protection.monthly_loss_value_type,
    protection.max_monthly_loss_percent,
    lossPercent(account.equity, account.monthStartEquity),
    protection.max_monthly_loss_cash,
    lossAmount(account.equity, account.monthStartEquity),
  )) return 'copy_risk_monthly_loss'
  const floatingLoss = Math.max(0, -account.floatingPnl)
  const floatingLossPct = account.equity > 0 ? (floatingLoss / account.equity) * 100 : 0
  if (unitHit(protection.floating_loss_value_type, protection.floating_loss_percent, floatingLossPct, protection.floating_loss, floatingLoss)) {
    return 'copy_risk_floating_loss'
  }
  const giveback = Math.max(0, account.floatingPeakProfit - account.floatingPnl)
  if (account.floatingPeakProfit > 0 && breached(protection.floating_profit_giveback, giveback)) {
    return 'copy_risk_profit_giveback'
  }
  const lockedProfit = account.equity - account.balanceReference
  if (breached(protection.profit_target_lock, lockedProfit)) return 'copy_risk_profit_lock'
  const dailyProfit = account.equity - account.dayStartEquity
  if (breached(protection.daily_profit_target, dailyProfit)) return 'copy_risk_daily_profit'
  if (breached(protection.max_consecutive_losses, account.consecutiveLosses)) return 'copy_risk_consecutive_losses'
  return null
}

function stale(account: CopyRiskAccountSnapshot, trade: CopyRiskTradeInput | undefined, maxAge: number | null): boolean {
  if (maxAge == null) return false
  const ages = [account.quotesAgeSeconds, account.equityAgeSeconds, trade?.snapshotAgeSeconds ?? null]
  return ages.some(age => age != null && age > maxAge)
}

function over(limit: number | null, value: number): boolean {
  return limit != null && value > limit
}

function roundToStep(lot: number, step: number): number {
  if (!(lot > 0)) return 0
  if (!(step > 0)) return Math.round(lot * 100) / 100
  const steps = Math.round(lot / step)
  return Math.round(steps * step * 1e8) / 1e8
}

function recoveryCapsMultipliers(risk: CopyRiskSettings, account: CopyRiskAccountSnapshot): boolean {
  if (!risk.protection.recovery_mode) return false
  return account.protectionLatched || account.consecutiveLosses > 0 || drawdownPercent(account) > 0
}

function drawdownLotFactor(risk: CopyRiskSettings, account: CopyRiskAccountSnapshot): number {
  const dd = drawdownPercent(account)
  const applicable = risk.advanced.drawdown_steps
    .filter(step => dd >= step.drawdown_percent)
    .sort((a, b) => a.drawdown_percent - b.drawdown_percent)
  if (!applicable.length) return 1
  return applicable[applicable.length - 1].lot_multiplier
}

function symbolOverride(risk: CopyRiskSettings, symbol: string): number | null {
  const match = risk.sizing.symbol_overrides.find(row => row.symbol.toLowerCase() === symbol.toLowerCase())
  return match ? match.fixed_lot : null
}

export interface SizedLot {
  lot: number
  reason: CopyRiskReason | null
}

/** Lot before exposure caps. Monetary modes ignore the lot multiplier. Volume modes apply the risk multiplier once. */
export function sizeCopyLot(
  riskInput: CopyRiskSettings | unknown,
  account: CopyRiskAccountSnapshot,
  trade: CopyRiskTradeInput,
  provider: CopyRiskProviderState | undefined,
  stopPips: number | null,
): SizedLot {
  const risk = normalizeCopyRisk(riskInput)
  const sizing = risk.sizing
  const override = symbolOverride(risk, trade.mappedSymbol || trade.symbol)
  const recovery = recoveryCapsMultipliers(risk, account)
  const riskMultiplier = recovery ? Math.min(1, risk.provider.risk_multiplier) : risk.provider.risk_multiplier
  const volumeMultiplier = (value: number) => (recovery ? Math.min(1, value) : value)
  let lot = sizing.fixed_lot
  let usedFallback = false

  if (override != null) {
    lot = override * riskMultiplier
  } else if (sizing.mode === 'fixed_lot') {
    lot = sizing.fixed_lot * (recovery ? Math.min(1, riskMultiplier) : riskMultiplier)
    if (riskMultiplier === 1) lot = sizing.fixed_lot
  } else if (sizing.mode === 'lot_multiplier') {
    lot = trade.lots * volumeMultiplier(sizing.lot_multiplier) * riskMultiplier
  } else if (sizing.mode === 'balance_ratio' || sizing.mode === 'equity_ratio') {
    const source = sizing.mode === 'balance_ratio' ? provider?.balance : provider?.equity
    const follower = sizing.mode === 'balance_ratio' ? account.balance : account.equity
    const multiplier = sizing.mode === 'balance_ratio' ? sizing.balance_multiplier : sizing.equity_multiplier
    if (source == null || !(source > 0) || !(follower > 0)) {
      lot = sizing.fixed_lot
      usedFallback = true
    } else {
      lot = trade.lots * (follower / source) * volumeMultiplier(multiplier) * riskMultiplier
    }
  } else if (sizing.mode === 'percent_risk' || sizing.mode === 'cash_risk' || sizing.mode === 'stop_distance') {
    if (stopPips == null || !(stopPips > 0)) return { lot: 0, reason: 'copy_risk_no_stop' }
    const rate = trade.quoteToAccountRate > 0 ? trade.quoteToAccountRate : 1
    const pipCash = trade.pipValuePerLot * rate
    if (!(pipCash > 0)) return { lot: 0, reason: 'copy_risk_volume_invalid' }
    if (sizing.mode === 'stop_distance') {
      lot = sizing.fixed_lot * (sizing.stop_distance_reference_pips / stopPips) * riskMultiplier
    } else {
      const riskCash = sizing.mode === 'percent_risk'
        ? account.equity * (sizing.percent_risk / 100) * riskMultiplier
        : sizing.cash_risk * riskMultiplier
      lot = riskCash / (stopPips * pipCash)
    }
  }

  if (VOLUME_MODES.has(sizing.mode) && override == null && !usedFallback && trade.contractSizeRatio > 0) {
    lot *= trade.contractSizeRatio
  }

  lot *= drawdownLotFactor(risk, account)
  if (!(lot > 0)) return { lot: 0, reason: usedFallback ? 'copy_risk_missing_source_equity' : 'copy_risk_volume_invalid' }
  return { lot, reason: usedFallback ? 'copy_risk_missing_source_equity' : null }
}

function sourceDistanceBreach(risk: CopyRiskSettings, trade: CopyRiskTradeInput): CopyRiskReason | null {
  const { stops, filters } = risk
  if (trade.stopPips != null) {
    if (stops.min_sl_pips != null && trade.stopPips < stops.min_sl_pips) return 'copy_risk_stop_distance'
    if (stops.max_sl_pips != null && trade.stopPips > stops.max_sl_pips) return 'copy_risk_stop_distance'
    if (trade.targetPips != null && trade.stopPips > 0) {
      const rr = trade.targetPips / trade.stopPips
      if (stops.min_rr != null && rr < stops.min_rr) return 'copy_risk_reward_risk'
      if (stops.max_rr != null && rr > stops.max_rr) return 'copy_risk_reward_risk'
      if (filters.min_reward_risk != null && rr < filters.min_reward_risk) return 'copy_risk_reward_risk'
    }
  }
  return null
}

export function resolveCopyStops(
  riskInput: CopyRiskSettings | unknown,
  trade: CopyRiskTradeInput,
): { stopPips: number | null; targetPips: number | null; reason: CopyRiskReason | null } {
  const risk = normalizeCopyRisk(riskInput)
  const sourceBreach = sourceDistanceBreach(risk, trade)
  if (sourceBreach && trade.stopPips != null) return { stopPips: null, targetPips: null, reason: sourceBreach }

  const stops = risk.stops
  let stop: number | null = null
  if (stops.force_sl && stops.fixed_sl_pips != null) stop = stops.fixed_sl_pips
  else if (stops.copy_source_sl && trade.stopPips != null) stop = trade.stopPips * stops.sl_multiplier + stops.sl_offset_pips
  else if (stops.fixed_sl_pips != null) stop = stops.fixed_sl_pips
  else stop = trade.stopPips

  let target: number | null = null
  if (stops.force_tp && stops.fixed_tp_pips != null) target = stops.fixed_tp_pips
  else if (stops.copy_source_tp && trade.targetPips != null) target = trade.targetPips * stops.tp_multiplier + stops.tp_offset_pips
  else if (stops.fixed_tp_pips != null) target = stops.fixed_tp_pips
  else target = trade.targetPips

  if (stop != null && stop < 0) stop = 0
  if (target != null && target < 0) target = 0

  const modificationsCapped = stops.max_sl_modifications != null
    && trade.slModificationCount >= stops.max_sl_modifications
    && trade.existingStopPips != null
  if (modificationsCapped) stop = trade.existingStopPips
  if (stops.never_widen_sl && trade.existingStopPips != null && (trade.proposedStopWider || (stop != null && stop > trade.existingStopPips))) {
    stop = trade.existingStopPips
  }

  if (risk.filters.require_stop && (stop == null || !(stop > 0))) {
    return { stopPips: stop, targetPips: target, reason: 'copy_risk_no_stop' }
  }
  if (stop != null && stop > 0) {
    if (stops.min_sl_pips != null && stop < stops.min_sl_pips) return { stopPips: stop, targetPips: target, reason: 'copy_risk_stop_distance' }
    if (stops.max_sl_pips != null && stop > stops.max_sl_pips) return { stopPips: stop, targetPips: target, reason: 'copy_risk_stop_distance' }
    if (target != null && target > 0) {
      const rr = target / stop
      if (stops.min_rr != null && rr < stops.min_rr) return { stopPips: stop, targetPips: target, reason: 'copy_risk_reward_risk' }
      if (stops.max_rr != null && rr > stops.max_rr) return { stopPips: stop, targetPips: target, reason: 'copy_risk_reward_risk' }
    }
  }
  return { stopPips: stop, targetPips: target, reason: null }
}

function filterReason(risk: CopyRiskSettings, trade: CopyRiskTradeInput, symbolsAllow?: string[] | null, symbolsDeny?: string[]): CopyRiskReason | null {
  const filters = risk.filters
  const symbol = (trade.mappedSymbol || trade.symbol).toLowerCase()
  if (symbolsAllow && symbolsAllow.length > 0 && !symbolsAllow.some(item => item.toLowerCase() === symbol)) {
    return 'symbol_not_in_whitelist'
  }
  if (symbolsDeny?.some(item => item.toLowerCase() === symbol)) return 'symbol_excluded'
  if (filters.direction !== 'both' && filters.direction !== trade.direction) return 'copy_risk_direction'
  if (!filters.order_types.includes(trade.orderType)) return 'copy_risk_order_type'
  if (filters.min_source_volume != null && trade.lots < filters.min_source_volume) return 'copy_risk_source_volume'
  if (filters.max_source_volume != null && trade.lots > filters.max_source_volume) return 'copy_risk_source_volume'
  if (over(filters.max_spread_points, trade.spreadPoints ?? Number.POSITIVE_INFINITY)) return 'copy_risk_spread'
  if (trade.spreadPoints == null && filters.max_spread_points != null) return 'copy_risk_spread'
  if (over(filters.max_entry_deviation_points, trade.deviationPoints ?? 0)) return 'copy_risk_entry_deviation'
  if (over(filters.max_price_move_points, trade.priceMovePoints ?? 0)) return 'copy_risk_price_move'
  if (over(filters.max_signal_age_seconds, trade.ageSeconds)) return 'copy_risk_signal_age'
  if (over(filters.max_source_position_age_seconds, trade.positionAgeSeconds)) return 'copy_risk_position_age'
  if (trade.alreadyCopied) return 'copy_risk_duplicate'
  if (trade.isCopy) return 'copy_risk_already_a_copy'
  if (filters.max_copies_per_period != null && trade.copiesInPeriod >= filters.max_copies_per_period) return 'copy_risk_copy_frequency'
  if (
    filters.min_seconds_between_copies != null
    && trade.secondsSinceLastCopy != null
    && trade.secondsSinceLastCopy < filters.min_seconds_between_copies
  ) return 'copy_risk_min_gap'
  return null
}

function stopRiskCash(lot: number, stopPips: number | null, trade: CopyRiskTradeInput): number {
  if (stopPips == null || !(stopPips > 0)) return 0
  const rate = trade.quoteToAccountRate > 0 ? trade.quoteToAccountRate : 1
  return lot * stopPips * trade.pipValuePerLot * rate
}

function applyExposure(
  risk: CopyRiskSettings,
  account: CopyRiskAccountSnapshot,
  positions: CopyRiskOpenPosition[],
  trade: CopyRiskTradeInput,
  provider: CopyRiskProviderState | undefined,
  lot: number,
  stopPips: number | null,
): { lot: number; reason: CopyRiskReason | null } {
  const exposure = risk.exposure
  const symbol = (trade.mappedSymbol || trade.symbol).toLowerCase()
  const open = positions.filter(position => !position.pending)
  const pending = positions.filter(position => position.pending)
  const sameSymbol = open.filter(position => position.symbol.toLowerCase() === symbol)
  const sameDirection = open.filter(position => position.direction === trade.direction)
  const providerId = provider?.id ?? null
  const providerPositions = providerId
    ? open.filter(position => position.providerId === providerId)
    : []

  if (exposure.max_open_positions != null && open.length >= exposure.max_open_positions) {
    return { lot: 0, reason: 'copy_risk_exposure' }
  }
  if (exposure.max_positions_per_symbol != null && sameSymbol.length >= exposure.max_positions_per_symbol) {
    return { lot: 0, reason: 'copy_risk_exposure' }
  }
  if (exposure.max_same_direction != null && sameDirection.length >= exposure.max_same_direction) {
    return { lot: 0, reason: 'copy_risk_exposure' }
  }
  if (trade.orderType !== 'market' && exposure.max_pending_orders != null && pending.length >= exposure.max_pending_orders) {
    return { lot: 0, reason: 'copy_risk_exposure' }
  }
  if (risk.provider.max_open_positions != null && provider && provider.openPositions >= risk.provider.max_open_positions) {
    return { lot: 0, reason: 'copy_risk_provider_positions' }
  }

  let next = lot
  let reason: CopyRiskReason | null = null
  const shrink = (capLots: number, code: CopyRiskReason) => {
    if (next > capLots) {
      next = capLots
      reason = code
    }
  }

  const openLots = open.reduce((sum, position) => sum + position.lots, 0)
  if (exposure.max_total_lots != null) shrink(exposure.max_total_lots - openLots, 'copy_risk_resized_exposure')
  const symbolLots = sameSymbol.reduce((sum, position) => sum + position.lots, 0)
  if (exposure.max_lots_per_symbol != null) shrink(exposure.max_lots_per_symbol - symbolLots, 'copy_risk_resized_exposure')
  if (exposure.max_order_volume != null) shrink(exposure.max_order_volume, 'copy_risk_resized_exposure')
  if (risk.provider.max_lots != null && provider) {
    shrink(risk.provider.max_lots - provider.openLots, 'copy_risk_provider_lots')
  }

  const aggregate = positions.reduce((sum, position) => sum + (position.stopRiskCash ?? 0), 0)
  if (exposure.max_aggregate_stop_risk != null && stopPips != null && stopPips > 0) {
    const room = exposure.max_aggregate_stop_risk - aggregate
    const perLot = stopRiskCash(1, stopPips, trade)
    if (perLot > 0) shrink(room / perLot, 'copy_risk_resized_exposure')
  }
  const symbolRisk = sameSymbol.reduce((sum, position) => sum + (position.stopRiskCash ?? 0), 0)
  if (exposure.max_stop_risk_per_symbol != null && stopPips != null && stopPips > 0) {
    const room = exposure.max_stop_risk_per_symbol - symbolRisk
    const perLot = stopRiskCash(1, stopPips, trade)
    if (perLot > 0) shrink(room / perLot, 'copy_risk_resized_exposure')
  }
  const providerRisk = providerPositions.reduce((sum, position) => sum + (position.stopRiskCash ?? 0), 0)
  if (exposure.max_stop_risk_per_provider != null && stopPips != null && stopPips > 0) {
    const room = exposure.max_stop_risk_per_provider - providerRisk
    const perLot = stopRiskCash(1, stopPips, trade)
    if (perLot > 0) shrink(room / perLot, 'copy_risk_resized_exposure')
  }

  const budget = risk.advanced.account_risk_budget
  if (budget != null && stopPips != null && stopPips > 0) {
    const allocation = risk.provider.allocation_percent
    const providerCap = allocation != null ? budget * (allocation / 100) : budget
    const accountRoom = budget - aggregate
    const providerRoom = providerCap - providerRisk
    const room = Math.min(accountRoom, providerRoom)
    const perLot = stopRiskCash(1, stopPips, trade)
    if (perLot > 0) shrink(room / perLot, 'copy_risk_resized_budget')
  }

  if (risk.advanced.auto_reduce) {
    const ratios: number[] = []
    if (exposure.max_margin_used_percent != null && exposure.max_margin_used_percent > 0) {
      ratios.push(account.marginUsedPercent / exposure.max_margin_used_percent)
    }
    if (exposure.max_total_lots != null && exposure.max_total_lots > 0) ratios.push(openLots / exposure.max_total_lots)
    if (exposure.max_open_positions != null && exposure.max_open_positions > 0) ratios.push(open.length / exposure.max_open_positions)
    const ddLimit = risk.protection.max_drawdown_percent
    if (ddLimit != null && ddLimit > 0) ratios.push(drawdownPercent(account) / ddLimit)
    const hottest = ratios.length ? Math.max(...ratios) : 0
    if (hottest > 0.8) {
      const factor = Math.max(0, (1 - hottest) / 0.2)
      const reduced = next * factor
      if (reduced < next) {
        next = reduced
        reason = 'copy_risk_auto_reduced'
      }
    }
  }

  if (!(next > 0)) return { lot: 0, reason: reason ?? 'copy_risk_exposure' }
  return { lot: next, reason }
}

function executionReason(
  risk: CopyRiskSettings,
  account: CopyRiskAccountSnapshot,
  trade: CopyRiskTradeInput,
  provider: CopyRiskProviderState | undefined,
): CopyRiskReason | null {
  const execution = risk.execution
  if (trade.mappedSymbol == null || !trade.mappedSymbol.trim()) return 'copy_risk_symbol_unmapped'
  if (over(execution.max_deviation_points, trade.deviationPoints ?? 0)) return 'copy_risk_deviation'
  if (over(execution.max_latency_seconds, trade.latencySeconds)) return 'copy_risk_latency'
  if (over(execution.max_spread_points, trade.spreadPoints ?? Number.POSITIVE_INFINITY)) return 'copy_risk_spread'
  if (trade.spreadPoints == null && execution.max_spread_points != null) return 'copy_risk_spread'
  if (account.tradingDisabled) return 'copy_risk_trading_disabled'
  if (execution.reject_insufficient_margin && trade.estimatedMargin != null && account.freeMargin < trade.estimatedMargin) {
    return 'copy_risk_margin'
  }
  if (risk.exposure.min_free_margin != null && account.freeMargin < risk.exposure.min_free_margin) return 'copy_risk_margin'
  if (risk.exposure.max_margin_per_order != null && trade.estimatedMargin != null && trade.estimatedMargin > risk.exposure.max_margin_per_order) {
    return 'copy_risk_margin'
  }
  if (
    risk.lifecycle.max_account_utilization_percent != null
    && account.marginUsedPercent >= risk.lifecycle.max_account_utilization_percent
  ) return 'copy_risk_utilization'
  if (risk.exposure.max_margin_used_percent != null && account.marginUsedPercent >= risk.exposure.max_margin_used_percent) {
    return 'copy_risk_margin'
  }
  if (provider && provider.suspended) return 'copy_risk_provider_suspended'
  if (provider && provider.allowFollowing === false) return 'copy_risk_allow_following'
  if (provider && risk.provider.max_loss != null && provider.loss >= risk.provider.max_loss) return 'copy_risk_provider_loss'
  if (provider && risk.provider.max_drawdown_percent != null && provider.drawdownPercent >= risk.provider.max_drawdown_percent) {
    return 'copy_risk_provider_drawdown'
  }
  if (provider && risk.provider.max_daily_trades != null && provider.dailyTrades >= risk.provider.max_daily_trades) {
    return 'copy_risk_provider_daily_trades'
  }
  if (provider && risk.provider.max_consecutive_losses != null && provider.consecutiveLosses >= risk.provider.max_consecutive_losses) {
    return 'copy_risk_provider_consecutive_losses'
  }
  if (provider && execution.failure_pause_after != null && provider.executionFailures >= execution.failure_pause_after) {
    return 'copy_risk_execution_failures'
  }
  if (provider && execution.slippage_pause_after != null && provider.slippageBreaches >= execution.slippage_pause_after) {
    return 'copy_risk_slippage_breaker'
  }
  return null
}

export function evaluateCopyAdmission(input: CopyRiskEvaluationInput): CopyRiskDecision {
  const risk = normalizeCopyRisk(input.risk)
  const account = input.account

  if (risk.protection.emergency_stop) {
    return decision('flatten', 'copy_risk_emergency_stop', { pause: true })
  }
  if (risk.lifecycle.account_locked || account.accountLocked) {
    return decision('pause', 'copy_risk_emergency_lock')
  }

  const guard = protectionReason(risk, account)
  if (guard) return protectionDecision(risk.protection.action, guard)
  if (input.copyLimitBreach === 'profit') return protectionDecision(risk.protection.action, 'copy_risk_profit_lock')
  if (input.copyLimitBreach === 'risk') return protectionDecision(risk.protection.action, 'copy_risk_drawdown')

  const disconnectLimit = risk.lifecycle.disconnect_action_after_seconds
  if (!account.connected && disconnectLimit != null && account.disconnectedSeconds >= disconnectLimit) {
    return protectionDecision(risk.lifecycle.disconnect_action, 'copy_risk_disconnect_timeout')
  }

  if (input.trigger === 'timer') return decision('allow', 'copy_risk_ok')

  if (!account.connected) return decision('skip', 'copy_risk_disconnected')
  if (stale(account, input.trade, risk.execution.max_snapshot_age_seconds)) return decision('skip', 'copy_risk_stale_data')
  if (risk.lifecycle.pause_new) return decision('skip', 'copy_paused')

  const trade = input.trade
  if (!trade) return decision('skip', 'copy_risk_ok')

  const provider = input.provider
  const providerBlock = executionReason(risk, account, trade, provider)
  if (providerBlock === 'copy_risk_provider_consecutive_losses' || providerBlock === 'copy_risk_execution_failures' || providerBlock === 'copy_risk_slippage_breaker') {
    return decision('pause', providerBlock)
  }
  if (providerBlock) return decision('skip', providerBlock)

  const filtered = filterReason(risk, trade, input.symbolsAllow, input.symbolsDeny)
  if (filtered) return decision('skip', filtered)

  const stops = resolveCopyStops(risk, trade)
  if (stops.reason) return decision('skip', stops.reason)

  const sized = sizeCopyLot(risk, account, trade, provider, stops.stopPips)
  if (sized.reason === 'copy_risk_no_stop' || sized.reason === 'copy_risk_volume_invalid') {
    return decision('skip', sized.reason)
  }
  let lot = sized.lot
  const exposed = applyExposure(risk, account, input.positions, trade, provider, lot, stops.stopPips)
  if (!(exposed.lot > 0)) return decision('skip', exposed.reason ?? 'copy_risk_exposure')
  lot = exposed.lot

  if (risk.sizing.max_lot != null && lot > risk.sizing.max_lot) {
    lot = risk.sizing.max_lot
  }
  if (lot < risk.sizing.min_lot) return decision('skip', 'copy_risk_volume_invalid')

  lot = roundToStep(lot, trade.volumeStep)
  if (lot < trade.minVolume || lot < risk.sizing.min_lot) return decision('skip', 'copy_risk_volume_invalid')
  if (lot > trade.maxVolume) lot = roundToStep(trade.maxVolume, trade.volumeStep)

  const placed: Omit<CopyRiskDecision, 'action' | 'reason'> = {
    lot,
    stopPips: stops.stopPips,
    targetPips: stops.targetPips,
    closeOnSourceExit: risk.stops.close_on_source_exit,
  }
  const resized = exposed.reason != null || (sized.lot - lot) > 1e-8
  if (resized) {
    return decision('resize', exposed.reason ?? 'copy_risk_resized_lot', placed)
  }
  return decision('allow', sized.reason ?? 'copy_risk_ok', placed)
}
