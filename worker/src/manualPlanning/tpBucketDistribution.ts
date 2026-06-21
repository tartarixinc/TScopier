import type { ManualTpLot } from './types'

export type TpBucketRow = { label: string; percent: number }

/** Treat legacy rows without `enabled` as on (matches AccountConfig sanitize). */
export function isTpLotRowEnabled(row: ManualTpLot | null | undefined): boolean {
  if (!row) return false
  return row.enabled !== false
}

/**
 * One bucket per signal TP index (TP1 → finalTps[0], …). Disabled / 0% rows keep
 * their slot but contribute no leg count — percents apply only on active buckets.
 */
export function resolveTpBucketRows(
  finalTps: number[],
  tpLots?: ManualTpLot[] | null,
): { bucketRows: TpBucketRow[]; bucketCount: number } {
  const tpCount = finalTps.length > 0 ? finalTps.length : 1
  const lots = tpLots ?? []

  const bucketRows: TpBucketRow[] = []
  for (let i = 0; i < tpCount; i++) {
    const row = lots[i]
    const enabled = row ? isTpLotRowEnabled(row) : false
    const pctRaw = enabled && row ? Number(row.percent) : 0
    const percent = Number.isFinite(pctRaw) && pctRaw > 0 ? pctRaw : 0
    bucketRows.push({
      label: String(row?.label ?? `TP${i + 1}`),
      percent,
    })
  }

  if (lots.length === 0 && bucketRows.length > 0) {
    bucketRows[0] = { label: 'TP1', percent: 100 }
  }

  const bucketCount = bucketRows.length > 0 ? bucketRows.length : 1
  return { bucketRows, bucketCount }
}

/** Split `count` open legs across TP buckets using Targets % (50/30/20, etc.). */
export function distributeCountAcrossTpBuckets(
  count: number,
  bucketRows: TpBucketRow[],
): number[] {
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

/** One take-profit price per open leg, ordered oldest→newest leg index. */
export function buildDistributedPerLegTakeProfits(args: {
  openLegCount: number
  finalTps: number[]
  tpLots?: ManualTpLot[] | null
}): number[] {
  const n = Math.max(0, args.openLegCount)
  if (n === 0) return []

  const tps = args.finalTps.filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0)
  if (!tps.length) return Array.from({ length: n }, () => 0)

  const { bucketRows } = resolveTpBucketRows(tps, args.tpLots)
  const counts = distributeCountAcrossTpBuckets(n, bucketRows)
  const prices: number[] = []
  for (let b = 0; b < bucketRows.length; b++) {
    const tpPrice = tps[b] ?? tps[tps.length - 1]!
    for (let k = 0; k < (counts[b] ?? 0); k++) prices.push(tpPrice)
  }
  while (prices.length < n) {
    prices.push(tps[tps.length - 1]!)
  }
  return prices.slice(0, n)
}

export type PerLegStopTargetLike = { stoploss: number; takeprofit: number }

/** Pad/truncate targets to exactly one row per open leg (reconcile jobs, modify pass). */
export function expandPerLegTargetsToCount(args: {
  targets: PerLegStopTargetLike[]
  openLegCount: number
  finalTps: number[]
  tpLots?: ManualTpLot[] | null
}): PerLegStopTargetLike[] {
  const n = Math.max(0, args.openLegCount)
  if (n === 0) return []
  if (args.targets.length >= n) return args.targets.slice(0, n)
  const sl = args.targets[0]?.stoploss ?? 0
  const tps = args.finalTps.length
    ? args.finalTps
    : args.targets.map(t => t.takeprofit).filter(tp => tp > 0)
  const tpPrices = buildDistributedPerLegTakeProfits({
    openLegCount: n,
    finalTps: tps,
    tpLots: args.tpLots,
  })
  return tpPrices.map(tp => ({ stoploss: sl, takeprofit: tp }))
}

/** Targets % TP price for a single leg index within one pool (instant or range). */
export function takeProfitForPoolLegIndex(args: {
  poolLegIndex: number
  poolLegCount: number
  finalTps: number[]
  tpLots?: ManualTpLot[] | null
}): number {
  const prices = buildDistributedPerLegTakeProfits({
    openLegCount: args.poolLegCount,
    finalTps: args.finalTps,
    tpLots: args.tpLots,
  })
  const i = args.poolLegIndex
  if (i < 0 || i >= prices.length) return 0
  return prices[i] ?? 0
}

/**
 * Targets % for a layered basket: instant legs and range legs each get their own
 * 50/30/20 (or configured %) split — not one combined pool across both groups.
 */
export function takeProfitForSplitBasketLeg(args: {
  legIndex: number
  immediateLegCount: number
  rangeLegCount: number
  finalTps: number[]
  tpLots?: ManualTpLot[] | null
}): number {
  const { legIndex, immediateLegCount, rangeLegCount, finalTps, tpLots } = args
  if (legIndex < immediateLegCount) {
    return takeProfitForPoolLegIndex({
      poolLegIndex: legIndex,
      poolLegCount: immediateLegCount,
      finalTps,
      tpLots,
    })
  }
  const rangeIdx = legIndex - immediateLegCount
  if (rangeIdx < 0 || rangeIdx >= rangeLegCount) return 0
  return takeProfitForPoolLegIndex({
    poolLegIndex: rangeIdx,
    poolLegCount: rangeLegCount,
    finalTps,
    tpLots,
  })
}

/** @deprecated Prefer {@link takeProfitForPoolLegIndex} or {@link takeProfitForSplitBasketLeg}. */
export function takeProfitForLegIndex(args: {
  legIndex: number
  openLegCount: number
  finalTps: number[]
  tpLots?: ManualTpLot[] | null
}): number {
  return takeProfitForPoolLegIndex({
    poolLegIndex: args.legIndex,
    poolLegCount: args.openLegCount,
    finalTps: args.finalTps,
    tpLots: args.tpLots,
  })
}

export type RangeBasketTpPhase = 'instant_only' | 'layering_rebalance'

export type EntryQualityLeg = {
  id: string
  entryPrice: number
  openedAt: string
}

/** Phase A until the first range layer has fired; then unified entry-quality rebalance. */
export function resolveRangeBasketTpPhase(args: {
  openLegCount: number
  immediateLegCount: number
  firedRangeLegCount: number
}): RangeBasketTpPhase {
  const { openLegCount, immediateLegCount, firedRangeLegCount } = args
  if (firedRangeLegCount > 0) return 'layering_rebalance'
  if (openLegCount > immediateLegCount) return 'layering_rebalance'
  return 'instant_only'
}

export function compareEntryQualityLegs(
  a: EntryQualityLeg,
  b: EntryQualityLeg,
  isBuy: boolean,
): number {
  const aEntry = Number(a.entryPrice)
  const bEntry = Number(b.entryPrice)
  const aFinite = Number.isFinite(aEntry)
  const bFinite = Number.isFinite(bEntry)
  if (aFinite && bFinite && aEntry !== bEntry) {
    return isBuy ? bEntry - aEntry : aEntry - bEntry
  }
  if (aFinite !== bFinite) return aFinite ? -1 : 1
  return a.openedAt.localeCompare(b.openedAt)
}

/**
 * Assign Targets % TP prices to legs sorted by entry quality (worst/earliest first → nearest TP).
 * `slotLegCount` is typically `legs.length` (current open count in phase B).
 */
export function buildEntryQualityTakeProfitMap(args: {
  legs: EntryQualityLeg[]
  isBuy: boolean
  slotLegCount: number
  finalTps: number[]
  tpLots?: ManualTpLot[] | null
}): Map<string, number> {
  const { legs, isBuy, slotLegCount, finalTps, tpLots } = args
  const out = new Map<string, number>()
  if (!legs.length || slotLegCount <= 0) return out

  const tps = finalTps.filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0)
  if (!tps.length) return out

  const slots = buildDistributedPerLegTakeProfits({
    openLegCount: slotLegCount,
    finalTps: tps,
    tpLots,
  })
  const sorted = [...legs].sort((a, b) => compareEntryQualityLegs(a, b, isBuy))
  for (let i = 0; i < sorted.length && i < slots.length; i++) {
    const tp = slots[i]!
    if (tp > 0) out.set(sorted[i]!.id, tp)
  }
  return out
}

export type RangeBasketOpenLeg = EntryQualityLeg & {
  stoploss?: number
}

/** Build per-leg SL/TP targets aligned to `openLegs` opened_at order for broker modify. */
export function buildRangeBasketPerLegStopTargets(args: {
  phase: RangeBasketTpPhase
  openLegs: RangeBasketOpenLeg[]
  immediateLegCount: number
  isBuy: boolean
  stoploss: number
  finalTps: number[]
  tpLots?: ManualTpLot[] | null
}): PerLegStopTargetLike[] {
  const { phase, openLegs, immediateLegCount, isBuy, stoploss, finalTps, tpLots } = args
  if (!openLegs.length) return []

  const tps = finalTps.filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0)

  if (phase === 'layering_rebalance') {
    const tpMap = buildEntryQualityTakeProfitMap({
      legs: openLegs,
      isBuy,
      slotLegCount: openLegs.length,
      finalTps: tps,
      tpLots,
    })
    return openLegs.map(leg => ({
      stoploss,
      takeprofit: tpMap.get(leg.id) ?? 0,
    }))
  }

  const instantPoolCount = Math.max(1, immediateLegCount)
  const instantTpPrices = buildDistributedPerLegTakeProfits({
    openLegCount: instantPoolCount,
    finalTps: tps,
    tpLots,
  })
  return openLegs.map((leg, i) => ({
    stoploss,
    takeprofit: instantTpPrices[i] ?? instantTpPrices[instantTpPrices.length - 1] ?? 0,
  }))
}

/** TP for one leg in phase B from the current open basket (entry-quality slot). */
export function takeProfitForEntryQualityLeg(args: {
  legId: string
  openLegs: EntryQualityLeg[]
  isBuy: boolean
  finalTps: number[]
  tpLots?: ManualTpLot[] | null
}): number {
  const tpMap = buildEntryQualityTakeProfitMap({
    legs: args.openLegs,
    isBuy: args.isBuy,
    slotLegCount: args.openLegs.length,
    finalTps: args.finalTps,
    tpLots: args.tpLots,
  })
  return tpMap.get(args.legId) ?? 0
}
