import type { ManualTpLot } from './types'

export type TpBucketRow = { label: string; percent: number }

/** Enabled target rows paired with parsed TP prices (same rules as multi-trade planner). */
export function resolveTpBucketRows(
  finalTps: number[],
  tpLots?: ManualTpLot[] | null,
): { bucketRows: TpBucketRow[]; bucketCount: number } {
  const enabledRows = (tpLots ?? []).filter(r => r && r.enabled)
  const bucketCount = finalTps.length > 0
    ? Math.max(1, Math.min(enabledRows.length || 1, finalTps.length))
    : 1
  const bucketRows: TpBucketRow[] = (enabledRows.length
    ? enabledRows
    : [{ label: 'TP1', lot: 0, percent: 100, enabled: true } as ManualTpLot])
    .slice(0, bucketCount)
    .map(r => ({
      label: String(r.label ?? 'TP'),
      percent: Number(r.percent),
    }))
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
  const weights = rawWeights.every(w => w === 0) ? bucketRows.map(() => 1) : rawWeights
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
