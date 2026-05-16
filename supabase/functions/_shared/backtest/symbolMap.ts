import type { MassiveAssetClass } from "../massiveApi.ts"

export interface SymbolMapping {
  massiveTicker: string
  assetClass: MassiveAssetClass
}

/** Map MT/Telegram symbols to Massive tickers (Polygon-style prefixes). */
export function mapSymbolToMassive(raw: string): SymbolMapping | null {
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (!s) return null

  const cryptoBases = new Set([
    "BTC", "ETH", "XRP", "SOL", "BNB", "ADA", "DOGE", "LTC", "DOT", "AVAX",
  ])
  const indexMap: Record<string, string> = {
    US30: "I:DJI",
    DJ30: "I:DJI",
    NAS100: "I:NDX",
    US100: "I:NDX",
    SPX500: "I:SPX",
    US500: "I:SPX",
    GER40: "I:DAX",
    DAX40: "I:DAX",
    UK100: "I:UKX",
    JP225: "I:N225",
  }

  if (indexMap[s]) {
    return { massiveTicker: indexMap[s], assetClass: "indices" }
  }

  if (s.endsWith("USD") && cryptoBases.has(s.slice(0, -3))) {
    return { massiveTicker: `X:${s}`, assetClass: "crypto" }
  }
  if (cryptoBases.has(s)) {
    return { massiveTicker: `X:${s}USD`, assetClass: "crypto" }
  }

  if (s.length === 6) {
    return { massiveTicker: `C:${s.slice(0, 3)}${s.slice(3)}`, assetClass: "forex" }
  }
  if (s.length === 7 && s.includes("USD")) {
    const base = s.replace("USD", "")
    if (base.length === 3) return { massiveTicker: `C:${base}USD`, assetClass: "forex" }
  }

  if (s.startsWith("XAU")) return { massiveTicker: "C:XAUUSD", assetClass: "forex" }
  if (s.startsWith("XAG")) return { massiveTicker: "C:XAGUSD", assetClass: "forex" }

  return { massiveTicker: `C:${s}`, assetClass: "forex" }
}

export function timeframeToAgg(timeframe: string): { multiplier: number; timespan: "minute" | "hour" | "day" } {
  switch (timeframe) {
    case "5m": return { multiplier: 5, timespan: "minute" }
    case "15m": return { multiplier: 15, timespan: "minute" }
    case "1h": return { multiplier: 1, timespan: "hour" }
    case "1d": return { multiplier: 1, timespan: "day" }
    default: return { multiplier: 1, timespan: "minute" }
  }
}
