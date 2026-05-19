/**
 * Mirror of `src/lib/backtestPip.ts` — keep in sync with TelegramBacktester pip rules.
 */

const METAL_ALIASES: Record<string, string> = {
  GOLD: "XAUUSD",
  XAU: "XAUUSD",
  XAG: "XAGUSD",
  SILVER: "XAGUSD",
}

export function normalizeBacktestSymbol(userSymbol: string): string {
  const raw = String(userSymbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
  if (METAL_ALIASES[raw]) return METAL_ALIASES[raw]
  if (raw.length >= 6) return raw.slice(0, 6)
  if (raw === "XAU") return "XAUUSD"
  if (raw === "XAG") return "XAGUSD"
  return raw
}

export function getPipMultiplierForSymbol(userSymbol: string): number {
  const pair = normalizeBacktestSymbol(userSymbol)
  if (pair.length < 6) return 10_000
  const base = pair.slice(0, 3)
  const quote = pair.slice(3, 6)
  if (base === "XAU" || base === "XAG") return 10
  if (quote === "JPY") return 100
  return 10_000
}

export function roundBacktestPips(pips: number): number {
  return Math.round(pips * 100) / 100
}

function sortTpPrices(direction: string, tpLevels: number[]): number[] {
  return [...tpLevels].sort((a, b) =>
    direction === "buy" ? a - b : b - a,
  )
}

export function computePipsFromSignalOutcome(input: {
  symbol: string
  direction: string
  entry: number
  sl: number | null
  tpLevels: number[]
  outcome: string
  tpsHit: number
}): number | null {
  const { symbol, direction, entry, sl, tpLevels, outcome, tpsHit } = input
  if (!(entry > 0)) return null
  if (outcome === "skipped" || outcome === "no_data" || outcome === "open") return null

  const mult = getPipMultiplierForSymbol(symbol)
  const sortedTPs = sortTpPrices(direction, tpLevels)

  if (outcome === "all_tp_hit" && sortedTPs.length > 0) {
    const highestTP = sortedTPs[sortedTPs.length - 1]!
    return roundBacktestPips(Math.abs(highestTP - entry) * mult)
  }

  if (
    (outcome === "tp1_then_sl" || outcome === "tp_then_be")
    && tpsHit > 0
    && sl != null
    && Number.isFinite(sl)
  ) {
    const lastHitTPPrice = sortedTPs[tpsHit - 1]
    if (lastHitTPPrice == null || !Number.isFinite(lastHitTPPrice)) return null
    const tpPips = Math.abs(lastHitTPPrice - entry) * mult
    const slPips = Math.abs(sl - entry) * mult
    return roundBacktestPips(tpPips - slPips)
  }

  if (outcome === "breakeven") return 0

  if (outcome === "sl_before_tp" && sl != null && Number.isFinite(sl)) {
    return roundBacktestPips(-(Math.abs(sl - entry) * mult))
  }

  return null
}

export function computeTradePipPnl(input: {
  symbol: string
  direction: string
  entry: number
  exit: number | null
  outcome: string
  tpLevels: number[]
  tpsHit?: number
  sl?: number | null
}): number | null {
  return computePipsFromSignalOutcome({
    symbol: input.symbol,
    direction: input.direction,
    entry: input.entry,
    sl: input.sl ?? null,
    tpLevels: input.tpLevels,
    outcome: input.outcome,
    tpsHit: input.tpsHit ?? (input.outcome === "all_tp_hit" ? input.tpLevels.length : 0),
  })
}
