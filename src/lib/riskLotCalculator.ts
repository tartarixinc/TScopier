import { estimateMultiTradeOrderCount } from './estimateMultiTradeOrders'
import { pipValueForLots, type PipQuote } from './pipCalculator'
import type { ManualSettings, ManualTpLot } from '../types/database'
import { DEFAULT_MANUAL_TP_LOTS } from './defaultManualSettings'

const FP_EPS = 1e-9
const DEFAULT_MIN_LOT = 0.01
const DEFAULT_LOT_STEP = 0.01

export interface RiskLotCalculatorState {
  accountBalance: number
  slPips: number
  tpPips: number[]
  tradeStyle: 'single' | 'multi'
  legPercent: number
  rangeTrading: boolean
  rangePercent: number
  rangeStepPips: number
  rangeDistancePips: number
  fixedLot: number
  tpLots: ManualTpLot[]
  /** Optional assumed win rate (0–100) for risk-of-ruin estimate. */
  winRatePct?: number | null
  /** Optional target risk % — when set, `suggestedLot` is computed. */
  targetRiskPct?: number | null
  minLot?: number
  lotStep?: number
}

export interface LegBreakdown {
  fallsBackSingle: boolean
  totalLegs: number
  immediateLegs: number
  pendingLegs: number
  perLegLot: number
  remainderLegLot: number
  totalLotsAtRisk: number
  immediateLotsAtRisk: number
  effectiveRangeSpanPips: number | null
}

export interface RewardRow {
  label: string
  lots: number
  pips: number
  percent: number
  reward: number
}

export interface RiskLotCalculatorResult {
  legs: LegBreakdown
  riskFullBasket: number
  riskImmediateOnly: number | null
  riskPctFull: number
  riskPctImmediate: number | null
  rewardRows: RewardRow[]
  totalReward: number
  rewardRiskRatio: number | null
  lossesToRuin: number | null
  riskOfRuinPct: number | null
  suggestedLot: number | null
  notes: string[]
}

function toUnits(v: number, lotStep: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0
  return Math.max(0, Math.floor(v / lotStep + FP_EPS))
}

function unitsToLot(u: number, lotStep: number): number {
  return Number((u * lotStep).toFixed(8))
}

function moneyPerPip(quote: PipQuote, lots: number): number {
  return pipValueForLots(quote, lots)
}

function isTpRowEnabled(row: ManualTpLot | null | undefined): boolean {
  if (!row) return false
  return row.enabled !== false
}

type TpBucketRow = { label: string; percent: number }

function resolveTpBucketRows(tpCount: number, tpLots: ManualTpLot[]): TpBucketRow[] {
  const rows: TpBucketRow[] = []
  for (let i = 0; i < tpCount; i++) {
    const row = tpLots[i]
    const enabled = row ? isTpRowEnabled(row) : false
    const pctRaw = enabled && row ? Number(row.percent) : 0
    const percent = Number.isFinite(pctRaw) && pctRaw > 0 ? pctRaw : 0
    rows.push({ label: String(row?.label ?? `TP${i + 1}`), percent })
  }
  if (tpLots.length === 0 && rows.length > 0) {
    rows[0] = { label: 'TP1', percent: 100 }
  }
  return rows
}

function distributeCountAcrossTpBuckets(count: number, bucketRows: TpBucketRow[]): number[] {
  const out = bucketRows.map(() => 0)
  if (count <= 0 || bucketRows.length === 0) return out

  const rawWeights = bucketRows.map(r => {
    const p = Number(r.percent)
    return Number.isFinite(p) && p > 0 ? p : 0
  })
  const hasPositive = rawWeights.some(w => w > 0)
  const weights = hasPositive ? rawWeights : bucketRows.map(() => 1)
  const sumW = weights.reduce((a, b) => a + b, 0) || bucketRows.length

  for (let i = 0; i < weights.length; i++) {
    out[i] = Math.round((count * weights[i]!) / sumW)
  }
  let drift = count - out.reduce((a, b) => a + b, 0)
  let idx = out.length - 1
  let guard = out.length * 2
  while (drift !== 0 && guard-- > 0) {
    if (drift > 0) {
      if (weights[idx]! > 0 || !hasPositive) {
        out[idx]! += 1
        drift -= 1
      }
    } else if (out[idx]! > 0) {
      out[idx]! -= 1
      drift += 1
    }
    idx = (idx - 1 + out.length) % out.length
    if (drift < 0 && out.every(c => c === 0)) break
  }
  return out
}

/** TP bucket index (0-based) per leg, oldest→newest. */
function tpIndexPerLeg(openLegCount: number, tpCount: number, tpLots: ManualTpLot[]): number[] {
  const n = Math.max(0, openLegCount)
  if (n === 0 || tpCount === 0) return []
  const bucketRows = resolveTpBucketRows(tpCount, tpLots)
  const counts = distributeCountAcrossTpBuckets(n, bucketRows)
  const indices: number[] = []
  for (let b = 0; b < bucketRows.length; b++) {
    for (let k = 0; k < (counts[b] ?? 0); k++) indices.push(b)
  }
  while (indices.length < n) indices.push(Math.min(tpCount - 1, bucketRows.length - 1))
  return indices.slice(0, n)
}

export function computeLegBreakdown(args: {
  fixedLot: number
  legPercent: number
  tradeStyle: 'single' | 'multi'
  rangeTrading: boolean
  rangePercent: number
  rangeStepPips: number
  rangeDistancePips: number
  minLot?: number
  lotStep?: number
}): LegBreakdown {
  const minLot = args.minLot ?? DEFAULT_MIN_LOT
  const lotStep = args.lotStep ?? DEFAULT_LOT_STEP
  const manualLot = Number(args.fixedLot)
  if (args.tradeStyle === 'single' || !Number.isFinite(manualLot) || manualLot <= 0) {
    return {
      fallsBackSingle: true,
      totalLegs: 1,
      immediateLegs: 1,
      pendingLegs: 0,
      perLegLot: manualLot > 0 ? manualLot : 0,
      remainderLegLot: 0,
      totalLotsAtRisk: manualLot > 0 ? manualLot : 0,
      immediateLotsAtRisk: manualLot > 0 ? manualLot : 0,
      effectiveRangeSpanPips: null,
    }
  }

  const legPct = Math.max(0.1, Math.min(100, Number(args.legPercent ?? 5)))
  const range = args.rangeTrading
    ? {
        enabled: true,
        percent: Number(args.rangePercent ?? 50) || 0,
        stepPips: Number(args.rangeStepPips ?? 0) || 0,
        distancePips: Number(args.rangeDistancePips ?? 0) || 0,
      }
    : undefined

  const preview = estimateMultiTradeOrderCount({
    manualLot,
    legPercent: legPct,
    minLot,
    lotStep,
    range,
  })

  if (preview.fallsBackSingle || preview.totalOrders <= 0) {
    return {
      fallsBackSingle: true,
      totalLegs: 1,
      immediateLegs: 1,
      pendingLegs: 0,
      perLegLot: manualLot,
      remainderLegLot: 0,
      totalLotsAtRisk: manualLot,
      immediateLotsAtRisk: manualLot,
      effectiveRangeSpanPips: null,
    }
  }

  const manualUnits = toUnits(manualLot, lotStep)
  const targetUnits = toUnits(manualLot * (legPct / 100), lotStep)
  const minUnits = Math.max(1, Math.round(minLot / lotStep))
  const perLegLot = unitsToLot(targetUnits, lotStep)
  const remainderUnits = manualUnits - preview.baseLegs * targetUnits
  const remainderLegLot =
    preview.extraRemainderLeg && remainderUnits >= minUnits
      ? unitsToLot(remainderUnits, lotStep)
      : 0

  const immediateLegs = preview.immediate ?? preview.totalOrders
  const pendingLegs = preview.pending ?? 0
  const totalLegs = preview.totalOrders
  const totalLotsAtRisk = perLegLot * (totalLegs - (remainderLegLot > 0 ? 1 : 0)) + remainderLegLot
  const immediateLotsAtRisk = perLegLot * immediateLegs

  return {
    fallsBackSingle: false,
    totalLegs,
    immediateLegs,
    pendingLegs,
    perLegLot,
    remainderLegLot,
    totalLotsAtRisk,
    immediateLotsAtRisk,
    effectiveRangeSpanPips: preview.effectiveDistancePips ?? null,
  }
}

function tpLevelCount(tpPips: number[], tpLots: ManualTpLot[]): number {
  return Math.max(tpPips.length, tpLots.length, 1)
}

function pipAt(tpPips: number[], idx: number): number {
  const n = Number(tpPips[idx])
  return Number.isFinite(n) && n > 0 ? n : 0
}

function computeSingleReward(args: {
  fixedLot: number
  tpPips: number[]
  tpLots: ManualTpLot[]
  quote: PipQuote
  minLot: number
  lotStep: number
}): { rows: RewardRow[]; total: number } {
  const { fixedLot, tpPips, tpLots, quote, minLot, lotStep } = args
  if (!Number.isFinite(fixedLot) || fixedLot <= 0) {
    return { rows: [], total: 0 }
  }

  const levelCount = tpLevelCount(tpPips, tpLots)
  const bucketRows = resolveTpBucketRows(levelCount, tpLots)
  const enabledWithPips = bucketRows
    .map((row, idx) => ({ row, idx, pips: pipAt(tpPips, idx) }))
    .filter(entry => entry.pips > 0 && entry.row.percent > 0)

  if (enabledWithPips.length === 0) {
    const fallbackPips = pipAt(tpPips, levelCount - 1) || pipAt(tpPips, 0)
    if (fallbackPips <= 0) return { rows: [], total: 0 }
    const reward = moneyPerPip(quote, fixedLot) * fallbackPips
    return {
      rows: [{ label: 'TP1', lots: fixedLot, pips: fallbackPips, percent: 100, reward }],
      total: reward,
    }
  }

  if (enabledWithPips.length === 1) {
    const only = enabledWithPips[0]!
    const reward = moneyPerPip(quote, fixedLot) * only.pips
    return {
      rows: [{
        label: only.row.label,
        lots: fixedLot,
        pips: only.pips,
        percent: only.row.percent,
        reward,
      }],
      total: reward,
    }
  }

  const minUnits = Math.max(1, Math.round(minLot / lotStep))
  const usableUnits = Math.max(0, toUnits(fixedLot, lotStep) - minUnits)
  let remainingUnits = usableUnits
  const rows: RewardRow[] = []

  const partialBuckets = enabledWithPips.slice(0, -1)
  const brokerBucket = enabledWithPips[enabledWithPips.length - 1]!

  for (const entry of partialBuckets) {
    const pct = entry.row.percent
    if (pct <= 0) continue
    let units = toUnits(fixedLot * (pct / 100), lotStep)
    if (units < minUnits) continue
    if (units > remainingUnits) {
      units = remainingUnits
      if (units < minUnits) continue
    }
    remainingUnits -= units
    const lots = unitsToLot(units, lotStep)
    rows.push({
      label: entry.row.label,
      lots,
      pips: entry.pips,
      percent: pct,
      reward: moneyPerPip(quote, lots) * entry.pips,
    })
    if (remainingUnits < minUnits) break
  }

  const remLots = +(fixedLot - rows.reduce((s, r) => s + r.lots, 0)).toFixed(8)
  if (remLots >= minLot) {
    rows.push({
      label: brokerBucket.row.label,
      lots: remLots,
      pips: brokerBucket.pips,
      percent: brokerBucket.row.percent,
      reward: moneyPerPip(quote, remLots) * brokerBucket.pips,
    })
  }

  const total = rows.reduce((s, r) => s + r.reward, 0)
  return { rows, total }
}

function computeMultiReward(args: {
  legs: LegBreakdown
  tpPips: number[]
  tpLots: ManualTpLot[]
  quote: PipQuote
}): { rows: RewardRow[]; total: number } {
  const { legs, tpPips, tpLots, quote } = args
  const levelCount = tpLevelCount(tpPips, tpLots)
  if (legs.totalLegs <= 0) {
    return { rows: [], total: 0 }
  }

  const immIndices = tpIndexPerLeg(legs.immediateLegs, levelCount, tpLots)
  const rangeIndices = tpIndexPerLeg(legs.pendingLegs, levelCount, tpLots)
  const allIndices = [...immIndices, ...rangeIndices]

  const bucketRows = resolveTpBucketRows(levelCount, tpLots)
  const agg = bucketRows.map((row, idx) => ({
    lots: 0,
    pips: pipAt(tpPips, idx),
    percent: row.percent,
    label: row.label,
  }))

  for (let i = 0; i < allIndices.length; i++) {
    const tpIdx = allIndices[i] ?? levelCount - 1
    const lot =
      i === allIndices.length - 1 && legs.remainderLegLot > 0
        ? legs.remainderLegLot
        : legs.perLegLot
    const bucket = agg[tpIdx]
    if (bucket && bucket.pips > 0) {
      bucket.lots += lot
    }
  }

  const rows: RewardRow[] = []
  let total = 0
  for (const bucket of agg) {
    if (bucket.lots <= 0 || bucket.pips <= 0 || bucket.percent <= 0) continue
    const reward = moneyPerPip(quote, bucket.lots) * bucket.pips
    rows.push({
      label: bucket.label,
      lots: bucket.lots,
      pips: bucket.pips,
      percent: bucket.percent,
      reward,
    })
    total += reward
  }
  return { rows, total }
}

function computeRiskDollars(args: {
  slPips: number
  quote: PipQuote
  legs: LegBreakdown
}): { full: number; immediate: number | null } {
  const { slPips, quote, legs } = args
  if (!Number.isFinite(slPips) || slPips <= 0) return { full: 0, immediate: null }

  if (legs.fallsBackSingle || legs.totalLegs <= 1) {
    const full = moneyPerPip(quote, legs.totalLotsAtRisk) * slPips
    return { full, immediate: null }
  }

  const perLegRisk = moneyPerPip(quote, legs.perLegLot) * slPips
  const remainderRisk =
    legs.remainderLegLot > 0 ? moneyPerPip(quote, legs.remainderLegLot) * slPips : 0
  const standardLegCount = legs.totalLegs - (legs.remainderLegLot > 0 ? 1 : 0)
  const full = perLegRisk * standardLegCount + remainderRisk
  const immediate = perLegRisk * legs.immediateLegs
  return { full, immediate: legs.pendingLegs > 0 ? immediate : null }
}

export function computeRiskOfRuinPct(args: {
  accountBalance: number
  riskPerSignal: number
  winRatePct: number
  rewardRiskRatio: number
}): number | null {
  const { accountBalance, riskPerSignal, winRatePct, rewardRiskRatio } = args
  if (
    accountBalance <= 0
    || riskPerSignal <= 0
    || winRatePct <= 0
    || winRatePct >= 100
    || rewardRiskRatio <= 0
  ) {
    return null
  }
  const p = winRatePct / 100
  const q = 1 - p
  const units = accountBalance / riskPerSignal
  const b = rewardRiskRatio

  const edge = p * b - q
  if (edge <= 0) return 100

  if (Math.abs(b - 1) < 0.001) {
    if (p <= q) return 100
    const ruin = Math.pow(q / p, units) * 100
    return Math.min(100, Math.max(0, ruin))
  }

  const ruin = Math.pow(q / p, units / b) * 100
  return Math.min(100, Math.max(0, ruin))
}

export function computeRiskLotCalculator(
  state: RiskLotCalculatorState,
  quote: PipQuote,
): RiskLotCalculatorResult {
  const minLot = state.minLot ?? DEFAULT_MIN_LOT
  const lotStep = state.lotStep ?? DEFAULT_LOT_STEP
  const notes: string[] = []

  const legs = computeLegBreakdown({
    fixedLot: state.fixedLot,
    legPercent: state.legPercent,
    tradeStyle: state.tradeStyle,
    rangeTrading: state.rangeTrading,
    rangePercent: state.rangePercent,
    rangeStepPips: state.rangeStepPips,
    rangeDistancePips: state.rangeDistancePips,
    minLot,
    lotStep,
  })

  if (legs.fallsBackSingle && state.tradeStyle === 'multi') {
    notes.push('multi_trade_fallback_min_lot')
  }

  const slPips = Math.max(0, Number(state.slPips) || 0)
  const tpPips = (state.tpPips ?? []).map(Number)
  const balance = Math.max(0, Number(state.accountBalance) || 0)

  const { full: riskFullBasket, immediate: riskImmediateOnly } = computeRiskDollars({
    slPips,
    quote,
    legs,
  })

  const riskPctFull = balance > 0 ? (riskFullBasket / balance) * 100 : 0
  const riskPctImmediate =
    riskImmediateOnly != null && balance > 0 ? (riskImmediateOnly / balance) * 100 : null

  const reward =
    state.tradeStyle === 'single'
      ? computeSingleReward({
          fixedLot: state.fixedLot,
          tpPips,
          tpLots: state.tpLots,
          quote,
          minLot,
          lotStep,
        })
      : computeMultiReward({ legs, tpPips, tpLots: state.tpLots, quote })

  const rewardRiskRatio =
    riskFullBasket > 0 && reward.total > 0 ? reward.total / riskFullBasket : null

  const lossesToRuin =
    riskFullBasket > 0 && balance > 0 ? Math.floor(balance / riskFullBasket) : null

  const winRate = state.winRatePct
  const riskOfRuinPct =
    winRate != null && Number.isFinite(winRate) && winRate > 0 && rewardRiskRatio != null
      ? computeRiskOfRuinPct({
          accountBalance: balance,
          riskPerSignal: riskFullBasket,
          winRatePct: winRate,
          rewardRiskRatio: rewardRiskRatio,
        })
      : null

  let suggestedLot: number | null = null
  const targetRisk = state.targetRiskPct
  if (targetRisk != null && Number.isFinite(targetRisk) && targetRisk > 0 && balance > 0) {
    suggestedLot = suggestLotForTargetRisk({
      ...state,
      minLot,
      lotStep,
      quote,
      targetRiskPct: targetRisk,
      accountBalance: balance,
    })
  }

  return {
    legs,
    riskFullBasket,
    riskImmediateOnly,
    riskPctFull,
    riskPctImmediate,
    rewardRows: reward.rows,
    totalReward: reward.total,
    rewardRiskRatio,
    lossesToRuin,
    riskOfRuinPct,
    suggestedLot,
    notes,
  }
}

function suggestLotForTargetRisk(
  args: RiskLotCalculatorState & {
    quote: PipQuote
    targetRiskPct: number
    minLot: number
    lotStep: number
  },
): number | null {
  const targetRiskDollars = (args.accountBalance * args.targetRiskPct) / 100
  if (targetRiskDollars <= 0) return null

  let lo = args.minLot
  let hi = 100
  let best = lo

  for (let i = 0; i < 40; i++) {
    const mid = +((lo + hi) / 2).toFixed(4)
    const result = computeRiskLotCalculator(
      { ...args, fixedLot: mid, targetRiskPct: null },
      args.quote,
    )
    if (result.riskFullBasket <= targetRiskDollars) {
      best = mid
      lo = mid
    } else {
      hi = mid
    }
  }

  return +best.toFixed(2)
}

export interface RiskLotCalculatorFormState {
  accountBalance: number
  symbol: string
  slPips: number
  tpPips: number[]
  tradeStyle: 'single' | 'multi'
  legPercent: number
  rangeTrading: boolean
  rangePercent: number
  rangeStepPips: number
  rangeDistancePips: number
  fixedLot: number
  tpLots: ManualTpLot[]
  winRatePct: number | null
  targetRiskPct: number | null
}

export function riskCalcStateFromManualSettings(
  ms: ManualSettings,
  accountBalance: number | null,
): RiskLotCalculatorFormState {
  const tpLots = Array.isArray(ms.tp_lots) && ms.tp_lots.length > 0
    ? ms.tp_lots.map((r, i) => ({
        label: String(r.label ?? `TP${i + 1}`),
        lot: Number(r.lot ?? 0.01) || 0.01,
        percent: Number(r.percent ?? 0) || 0,
        enabled: r.enabled !== false,
      }))
    : DEFAULT_MANUAL_TP_LOTS.map(r => ({ ...r }))

  const rawTpPips = Array.isArray(ms.predefined_tp_pips)
    ? ms.predefined_tp_pips.map(Number).filter(n => Number.isFinite(n) && n > 0)
    : []
  const fallbackPips = rawTpPips.length > 0 ? rawTpPips : [20, 40, 60]
  const levelCount = Math.max(tpLots.length, fallbackPips.length, 1)
  const tpPips = Array.from({ length: levelCount }, (_, i) => {
    const fromSettings = Number(ms.predefined_tp_pips?.[i])
    if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings
    return fallbackPips[i] ?? fallbackPips[fallbackPips.length - 1] ?? 20 * (i + 1)
  })

  return {
    accountBalance: accountBalance != null && Number.isFinite(accountBalance) ? accountBalance : 10000,
    symbol: (ms.symbol_to_trade ?? '').trim().split(/[,;\s]+/).filter(Boolean)[0]?.toUpperCase() ?? '',
    slPips: Number(ms.predefined_sl_pips ?? 30) || 30,
    tpPips,
    tradeStyle: ms.trade_style === 'multi' ? 'multi' : 'single',
    legPercent: Number(ms.multi_trade_leg_percent ?? 5) || 5,
    rangeTrading: ms.range_trading === true,
    rangePercent: Number(ms.range_percent ?? 50) || 50,
    rangeStepPips: Number(ms.range_step_pips ?? 3) || 3,
    rangeDistancePips: Number(ms.range_distance_pips ?? 30) || 30,
    fixedLot: Number(ms.fixed_lot ?? 0.01) || 0.01,
    tpLots: tpLots.length >= levelCount
      ? tpLots
      : [
          ...tpLots,
          ...Array.from({ length: levelCount - tpLots.length }, (_, i) => ({
            label: `TP${tpLots.length + i + 1}`,
            lot: 0.01,
            percent: 0,
            enabled: true,
          })),
        ],
    winRatePct: null,
    targetRiskPct: null,
  }
}

export function manualSettingsFromRiskCalc(form: RiskLotCalculatorFormState): Partial<ManualSettings> {
  const symbol = form.symbol.trim().toUpperCase()
  return {
    ...(symbol ? { symbol_to_trade: symbol } : {}),
    fixed_lot: form.fixedLot,
    trade_style: form.tradeStyle,
    multi_trade_leg_percent: form.legPercent,
    range_trading: form.tradeStyle === 'multi' ? form.rangeTrading : false,
    range_percent: form.rangePercent,
    range_step_pips: form.rangeStepPips,
    range_distance_pips: form.rangeDistancePips,
    use_predefined_sl_pips: true,
    predefined_sl_pips: Math.max(1, Math.round(form.slPips)),
    use_predefined_tp_pips: true,
    predefined_tp_pips: form.tpPips.map(p => Math.max(1, Math.round(p))),
    tp_lots: form.tpLots.map((r, i) => ({
      label: String(r.label ?? `TP${i + 1}`),
      lot: Number(r.lot ?? 0.01) || 0.01,
      percent: Number(r.percent ?? 0) || 0,
      enabled: r.enabled !== false,
    })),
  }
}
