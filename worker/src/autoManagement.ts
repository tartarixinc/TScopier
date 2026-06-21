import { isPartialTpTriggered } from './partialTpMonitor'
import { signalPipPrice } from './signalPip'

/** Keep snapshot helpers in sync with supabase/functions/_shared/autoManagement.ts */

export const BREAKEVEN_OFFSET_PIPS_DEFAULT = 3

export type AutoBeMode = 'pips' | 'rr' | 'money' | 'tp_hit'
export type AutoBeType = 'sl_only' | 'sl_and_close_half'

export interface AutoBeConfig {
  mode: AutoBeMode
  triggerValue: number
  tpIndex: number
  beType: AutoBeType
  offsetPips: number
}

export interface AutoBeTriggerInput {
  mode: AutoBeMode
  triggerValue: number
  tpIndex: number
  isBuy: boolean
  entryPrice: number
  riskSl: number | null
  bid: number
  ask: number
  pipPrice: number
  pipValuePerLot: number
  partialTpFiredIndices: number[]
  partialTpTriggers: Array<{ tpIdx: number; triggerPrice: number }>
  brokerTp: number | null
}

function roundPrice(v: number, digits: number): number {
  if (!Number.isFinite(v)) return v
  return Number(v.toFixed(digits))
}

function positiveNum(v: number, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Pips beyond entry when channel or auto breakeven moves SL (default 3). */
export function resolveBreakevenOffsetPips(manual: {
  breakeven_offset_pips?: number
}): number {
  const raw = manual.breakeven_offset_pips
  if (raw === undefined || raw === null) return BREAKEVEN_OFFSET_PIPS_DEFAULT
  return positiveNum(raw, BREAKEVEN_OFFSET_PIPS_DEFAULT)
}

function defaultDigitsForPip(pip: number): number {
  if (pip >= 0.01) return 2
  if (pip >= 0.001) return 3
  return 5
}

/** Channel breakeven SL from entry + configured offset for a symbol. */
export function breakevenStopLossForSymbol(args: {
  isBuy: boolean
  entryPrice: number
  manual: { breakeven_offset_pips?: number }
  symbol: string
  digits?: number
}): number {
  const pip = signalPipPrice(args.symbol)
  const digits = args.digits ?? defaultDigitsForPip(pip)
  return computeBreakevenStopLoss(
    args.isBuy,
    args.entryPrice,
    resolveBreakevenOffsetPips(args.manual),
    pip,
    digits,
  )
}

/** True when manual settings enable auto move-SL-to-breakeven. */
export function isAutoManagementEnabled(manual: {
  move_sl_to_entry_after_mode?: string
}): boolean {
  const mode = String(manual.move_sl_to_entry_after_mode ?? 'none').toLowerCase()
  return mode !== 'none' && mode !== ''
}

export function normalizeAutoBeConfig(manual: {
  move_sl_to_entry_after_mode?: string
  move_sl_to_entry_after_value?: number
  move_sl_to_entry_tp_index?: number
  move_sl_to_entry_type?: string
  breakeven_offset_pips?: number
}): AutoBeConfig | null {
  const rawMode = String(manual.move_sl_to_entry_after_mode ?? 'none').toLowerCase()
  if (rawMode === 'none' || rawMode === '') return null
  const mode: AutoBeMode =
    rawMode === 'pips' || rawMode === 'rr' || rawMode === 'money' || rawMode === 'tp_hit'
      ? rawMode
      : 'pips'
  const beRaw = String(manual.move_sl_to_entry_type ?? 'sl_only').toLowerCase()
  const beType: AutoBeType = beRaw === 'sl_and_close_half' ? 'sl_and_close_half' : 'sl_only'
  return {
    mode,
    triggerValue: positiveNum(manual.move_sl_to_entry_after_value ?? 0, mode === 'rr' ? 1 : 10),
    tpIndex: Math.max(1, Math.floor(Number(manual.move_sl_to_entry_tp_index ?? 1) || 1)),
    beType,
    offsetPips: resolveBreakevenOffsetPips(manual),
  }
}

/** DB columns to set on trades.insert when auto-management is active. */
export function autoManagementTradeSnapshot(
  manual: {
    move_sl_to_entry_after_mode?: string
    move_sl_to_entry_after_value?: number
    move_sl_to_entry_tp_index?: number
    move_sl_to_entry_type?: string
    breakeven_offset_pips?: number
  },
  entryPrice: number | null | undefined,
  sl: number | null | undefined,
): Record<string, string | number | null> {
  if (!isAutoManagementEnabled(manual)) return {}
  const entry = Number(entryPrice)
  if (!Number.isFinite(entry) || entry <= 0) return {}
  const cfg = normalizeAutoBeConfig(manual)
  if (!cfg) return {}
  const riskSl = sl != null && Number.isFinite(Number(sl)) && Number(sl) > 0 ? Number(sl) : null
  return {
    auto_be_mode: cfg.mode,
    auto_be_trigger_value: cfg.triggerValue,
    auto_be_tp_index: cfg.tpIndex,
    auto_be_type: cfg.beType,
    auto_be_offset_pips: cfg.offsetPips,
    auto_be_risk_sl: riskSl,
    auto_be_applied_at: null,
  }
}

export function computeBreakevenStopLoss(
  isBuy: boolean,
  entryPrice: number,
  offsetPips: number,
  pipPrice: number,
  digits: number,
): number {
  const offset = offsetPips * pipPrice
  const raw = isBuy ? entryPrice + offset : entryPrice - offset
  return roundPrice(raw, digits)
}

/** Prefer live broker SL over shared basket SL stored on the trades row. */
export function resolveSlForBreakevenCheck(
  dbSl: number | null,
  brokerSl: number | null | undefined,
): number | null {
  const live = brokerSl != null ? Number(brokerSl) : NaN
  if (Number.isFinite(live) && live > 0) return live
  if (dbSl != null && Number.isFinite(dbSl) && dbSl > 0) return dbSl
  return null
}

/** Skip when SL is already at or beyond the breakeven level. */
export function isSlAtOrBeyondBreakeven(
  isBuy: boolean,
  currentSl: number | null,
  beSl: number,
  pipPrice: number,
): boolean {
  if (currentSl == null || !Number.isFinite(currentSl) || currentSl <= 0) return false
  const tol = pipPrice * 0.5
  if (isBuy) return currentSl >= beSl - tol
  return currentSl <= beSl + tol
}

/** Clamp breakeven SL/TP to broker min distance from the live quote. */
export function clampBreakevenModifyStops(args: {
  isBuy: boolean
  stoploss: number
  takeprofit: number
  referencePrice: number
  point: number
  digits: number
  stopsLevel: number
  freezeLevel: number
}): { stoploss: number; takeprofit: number } {
  const { isBuy, referencePrice: ref, point, digits, stopsLevel, freezeLevel } = args
  if (!Number.isFinite(ref) || ref <= 0 || point <= 0) {
    return { stoploss: args.stoploss, takeprofit: args.takeprofit }
  }
  const minLevel = Math.max(stopsLevel, freezeLevel)
  const minDist = (minLevel + 2) * point
  if (minDist <= 0) return { stoploss: args.stoploss, takeprofit: args.takeprofit }

  const round = (v: number): number => Number(v.toFixed(Math.max(0, Math.min(8, digits))))
  let stoploss = args.stoploss
  let takeprofit = args.takeprofit

  if (isBuy) {
    if (stoploss > 0 && ref - stoploss < minDist) stoploss = round(ref - minDist)
    if (takeprofit > 0 && takeprofit - ref < minDist) takeprofit = round(ref + minDist)
  } else {
    if (stoploss > 0 && stoploss - ref < minDist) stoploss = round(ref + minDist)
    if (takeprofit > 0 && ref - takeprofit < minDist) takeprofit = round(ref - minDist)
  }

  return { stoploss, takeprofit }
}

export function profitPips(
  isBuy: boolean,
  entryPrice: number,
  favorable: number,
  pipPrice: number,
): number {
  if (!Number.isFinite(pipPrice) || pipPrice <= 0) return 0
  return isBuy
    ? (favorable - entryPrice) / pipPrice
    : (entryPrice - favorable) / pipPrice
}

/** Returns true when the configured trigger condition is satisfied. */
export function isAutoBeTriggerMet(input: AutoBeTriggerInput): boolean {
  const {
    mode,
    triggerValue,
    tpIndex,
    isBuy,
    entryPrice,
    riskSl,
    bid,
    ask,
    pipPrice,
    pipValuePerLot,
    partialTpFiredIndices,
    partialTpTriggers,
    brokerTp,
  } = input
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false

  const favorable = isBuy ? bid : ask
  if (!Number.isFinite(favorable) || favorable <= 0) return false

  switch (mode) {
    case 'pips':
      return profitPips(isBuy, entryPrice, favorable, pipPrice) >= triggerValue
    case 'rr': {
      if (riskSl == null || !Number.isFinite(riskSl)) return false
      const risk = Math.abs(entryPrice - riskSl)
      if (risk <= 0) return false
      const reward = Math.abs(favorable - entryPrice)
      return reward / risk >= triggerValue
    }
    case 'money': {
      const pips = profitPips(isBuy, entryPrice, favorable, pipPrice)
      const profitMoney = pips * pipValuePerLot
      return profitMoney >= triggerValue
    }
    case 'tp_hit': {
      const target = Math.max(1, Math.floor(tpIndex))
      if (partialTpFiredIndices.includes(target)) return true
      const leg = partialTpTriggers.find(p => p.tpIdx === target)
      if (leg && Number.isFinite(leg.triggerPrice) && leg.triggerPrice > 0) {
        return isPartialTpTriggered(isBuy, leg.triggerPrice, bid, ask)
      }
      if (target === 1 && brokerTp != null && Number.isFinite(brokerTp) && brokerTp > 0) {
        return isPartialTpTriggered(isBuy, brokerTp, bid, ask)
      }
      return false
    }
    default:
      return false
  }
}
