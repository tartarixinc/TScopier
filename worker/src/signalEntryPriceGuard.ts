/**
 * AI-lane entry guard: reject a parsed entry when the live market has moved
 * adversarially past the signal entry price/zone beyond the broker's pip
 * tolerance. Entering a worse price than the signal published is a loss risk.
 */
import { stripInvalidStopsForSide } from './channelActiveTradeParams'

export const ENTRY_PRICE_MOVED_ADVERSE_REASON = 'entry_price_moved_adverse'

/**
 * Reason recorded when every signal take-profit already sits on the wrong
 * side of the live quote, so the copy is skipped instead of opening with a
 * stripped (naked) ladder.
 */
export const ENTRY_TPS_BEYOND_MARKET_REASON = 'entry_tps_beyond_market'

function positive(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function parsePipSize(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0.00001
}

/**
 * True when the reference quote is beyond the entry (or zone edge) on the
 * adverse side by more than tolerancePips × pipSize.
 *
 * Buy:  adverse = ask above entry/zone (paying more than the signal).
 * Sell: adverse = bid below entry/zone (receiving less than the signal).
 * A price that moved in favor of the trade is never blocked.
 */
export function entryPriceMovedAdverse(args: {
  action: 'buy' | 'sell'
  entryPrice: number | null
  zoneLow: number | null
  zoneHigh: number | null
  bid: number
  ask: number
  tolerancePips: number
  pipSize?: number | null
}): boolean {
  const { action, bid, ask } = args
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return false

  const entry = positive(args.entryPrice)
  const lo = positive(args.zoneLow)
  const hi = positive(args.zoneHigh)
  if (entry == null && (lo == null || hi == null)) return false

  const tolerance = Math.max(0, Number(args.tolerancePips)) * parsePipSize(args.pipSize)

  if (action === 'buy') {
    const cap = entry != null ? entry : hi!
    return ask > cap + tolerance
  }
  const floor = entry != null ? entry : lo!
  return bid < floor - tolerance
}

/**
 * True when a signal's take-profit ladder has at least one price level for
 * this quote and EVERY such level would be stripped before send (wrong side
 * of the fill or too close to it) — a buy whose TPs are all at/below the ask,
 * a sell whose TPs are all at/above the bid. The copy would open with no
 * usable take-profit, so the entry is skipped instead (2026-11-09, Luis /
 * Gold PRO: BUY entry 4017 filled at 4116.7 with TPs 4020/4024/4026).
 *
 * Judged with the same strip rule the send path uses (`stripInvalidStopsForSide`),
 * so the guard fires exactly when the order would go out with takeprofit 0.
 * Pip-denominated ladders (`tpUnit === 'pips'`) and levels that cannot be
 * prices for this quote (pip offsets like 15/30) are never judged; false is
 * returned when nothing can be assessed — the guard is best-effort and must
 * never block on missing data.
 */
export function allTakeProfitsBeyondMarket(args: {
  action: 'buy' | 'sell'
  tpLevels: unknown
  bid: number
  ask: number
  tpUnit?: unknown
  symbol?: string | null
}): boolean {
  const { action, bid, ask } = args
  if (action !== 'buy' && action !== 'sell') return false
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return false
  if (String(args.tpUnit ?? '').toLowerCase() === 'pips') return false
  const levels = (Array.isArray(args.tpLevels) ? args.tpLevels : [])
    .map(v => Number(v))
    .filter(n => Number.isFinite(n) && n > 0)
  if (!levels.length) return false
  const ref = action === 'buy' ? ask : bid
  // Quote-relative plausibility: a level far off the quote is not a price for
  // this instrument (pip offsets like 15/30 against a ~4100 fill). Same rule
  // as the frontend's strippedTpNotice (src/lib/tradeExecutionNotes.ts) —
  // deliberately quote-relative, unlike filterPlausibleInstrumentPrices
  // (symbol minimum) and looksLikePipOffsetMagnitudes (absolute magnitude).
  const plausible = levels.filter(t => t > ref / 2 && t < ref * 2)
  if (!plausible.length) return false
  return plausible.every(t => stripInvalidStopsForSide({
    stoploss: 0,
    takeprofit: t,
    referencePrice: ref,
    isBuy: action === 'buy',
    symbol: args.symbol,
  }).takeprofit === 0)
}
