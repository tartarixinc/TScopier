/**
 * Targets % TP distribution — keep in sync with worker/src/manualPlanning/tpBucketDistribution.ts
 */

export type ManualTpLotLike = {
  label?: string
  lot?: number
  percent?: number
  enabled?: boolean
}

export type TpBucketRow = { label: string; percent: number }

export function isTpLotRowEnabled(row: ManualTpLotLike | null | undefined): boolean {
  if (!row) return false
  return row.enabled !== false
}

export function resolveTpBucketRows(
  finalTps: number[],
  tpLots?: ManualTpLotLike[] | null,
): { bucketRows: TpBucketRow[]; bucketCount: number } {
  const enabledRows = (tpLots ?? []).filter((r) => isTpLotRowEnabled(r))
  const bucketCount = finalTps.length > 0
    ? Math.max(1, Math.min(enabledRows.length || 1, finalTps.length))
    : 1
  const bucketRows: TpBucketRow[] = (enabledRows.length
    ? enabledRows
    : [{ label: "TP1", lot: 0, percent: 100, enabled: true }])
    .slice(0, bucketCount)
    .map((r) => ({
      label: String(r.label ?? "TP"),
      percent: Number(r.percent),
    }))
  return { bucketRows, bucketCount }
}

export function distributeCountAcrossTpBuckets(count: number, bucketRows: TpBucketRow[]): number[] {
  const out = bucketRows.map(() => 0)
  if (count <= 0 || bucketRows.length === 0) return out
  const rawWeights = bucketRows.map((r) => {
    const p = Number(r.percent)
    return Number.isFinite(p) && p > 0 ? p : 0
  })
  const weights = rawWeights.every((w) => w === 0) ? bucketRows.map(() => 1) : rawWeights
  const sumW = weights.reduce((a, b) => a + b, 0) || bucketRows.length
  for (let i = 0; i < weights.length; i++) {
    out[i] = Math.round((count * weights[i]!) / sumW)
  }
  let drift = count - out.reduce((a, b) => a + b, 0)
  let idx = out.length - 1
  let guard = out.length * 2
  while (drift !== 0 && guard-- > 0) {
    if (drift > 0) {
      out[idx]! += 1
      drift -= 1
    } else if (out[idx]! > 0) {
      out[idx]! -= 1
      drift += 1
    }
    idx = (idx - 1 + out.length) % out.length
    if (drift < 0 && out.every((c) => c === 0)) break
  }
  return out
}

export function buildDistributedPerLegTakeProfits(args: {
  openLegCount: number
  finalTps: number[]
  tpLots?: ManualTpLotLike[] | null
}): number[] {
  const n = Math.max(0, args.openLegCount)
  if (n === 0) return []
  const tps = args.finalTps.filter((t) => typeof t === "number" && Number.isFinite(t) && t > 0)
  if (!tps.length) return Array.from({ length: n }, () => 0)
  const { bucketRows } = resolveTpBucketRows(tps, args.tpLots)
  const counts = distributeCountAcrossTpBuckets(n, bucketRows)
  const prices: number[] = []
  for (let b = 0; b < bucketRows.length; b++) {
    const tpPrice = tps[b] ?? tps[tps.length - 1]!
    for (let k = 0; k < (counts[b] ?? 0); k++) prices.push(tpPrice)
  }
  while (prices.length < n) prices.push(tps[tps.length - 1]!)
  return prices.slice(0, n)
}

export type PerLegStopTargetLike = { stoploss: number; takeprofit: number }

export function expandPerLegTargetsToCount(args: {
  targets: PerLegStopTargetLike[]
  openLegCount: number
  finalTps: number[]
  tpLots?: ManualTpLotLike[] | null
}): PerLegStopTargetLike[] {
  const n = Math.max(0, args.openLegCount)
  if (n === 0) return []
  if (args.targets.length >= n) return args.targets.slice(0, n)
  const sl = args.targets[0]?.stoploss ?? 0
  const tps = args.finalTps.length
    ? args.finalTps
    : args.targets.map((t) => t.takeprofit).filter((tp) => tp > 0)
  const tpPrices = buildDistributedPerLegTakeProfits({
    openLegCount: n,
    finalTps: tps,
    tpLots: args.tpLots,
  })
  return tpPrices.map((tp) => ({ stoploss: sl, takeprofit: tp }))
}

export function takeProfitForLegIndex(args: {
  legIndex: number
  openLegCount: number
  finalTps: number[]
  tpLots?: ManualTpLotLike[] | null
}): number {
  const prices = buildDistributedPerLegTakeProfits({
    openLegCount: args.openLegCount,
    finalTps: args.finalTps,
    tpLots: args.tpLots,
  })
  const i = args.legIndex
  if (i < 0 || i >= prices.length) return 0
  return prices[i] ?? 0
}
