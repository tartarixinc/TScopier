import type { MtTrade } from './fxsocketBroker'
import { formatBrokerHistoryDate, parseMtHistoryTimestamp } from './mtApiDateTime'

/** Re-read a day around the newest cached close so late broker writes are not missed. */
export const TRADES_INCREMENTAL_BUFFER_MS = 24 * 60 * 60 * 1000

/** Never request more than this on a normal refresh, even for a dormant account. */
export const TRADES_MAX_INCREMENTAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Re-read the full broker history once a day to drop deleted or corrected old rows. */
export const TRADES_FULL_HISTORY_REFRESH_MS = 24 * 60 * 60 * 1000

function tradeDisplayMs(trade: MtTrade): number {
  const raw = trade.status === 'closed'
    ? (trade.closed_at ?? trade.opened_at)
    : trade.opened_at
  return parseMtHistoryTimestamp(raw) ?? 0
}

function compareNewestFirst(a: MtTrade, b: MtTrade): number {
  return tradeDisplayMs(b) - tradeDisplayMs(a)
}

/**
 * First day to request for an incremental refresh.
 *
 * The cutoff is the newest cached close minus a one-day buffer, clamped to the
 * last seven days. The clamp matters for dormant accounts: without it, a
 * months-old close would make every refresh re-read months of history. When
 * the cache has no closed trades, start from yesterday: open orders are
 * returned by the broker regardless of the closed-history range.
 */
export function incrementalHistoryFrom(
  trades: readonly MtTrade[],
  now = Date.now(),
  bufferMs = TRADES_INCREMENTAL_BUFFER_MS,
  maxWindowMs = TRADES_MAX_INCREMENTAL_WINDOW_MS,
): string {
  let newestClose = 0
  for (const trade of trades) {
    if (trade.status !== 'closed') continue
    const ms = parseMtHistoryTimestamp(trade.closed_at ?? trade.opened_at)
    if (ms != null && ms > newestClose) newestClose = ms
  }
  const anchor = newestClose > 0 ? newestClose : now
  const from = Math.min(Math.max(anchor - bufferMs, now - maxWindowMs), now)
  return formatBrokerHistoryDate(new Date(from))
}

/**
 * Merge a recent-window live read with cached closed trades.
 *
 * Live rows win by `id`. Cached closed rows missing from the live read are
 * kept so a partial bridge response cannot make trades disappear; the daily
 * full refresh is what removes genuinely deleted rows. Cached open rows are
 * not merged: the live read is the authority for the current open set, and a
 * partial provider response is already surfaced by the degraded-feed banner.
 * When `accountIds` is supplied, rows for accounts that are no longer linked
 * are dropped.
 */
export function mergeIncrementalTrades(
  live: readonly MtTrade[],
  cached: readonly MtTrade[],
  accountIds?: ReadonlySet<string>,
): MtTrade[] {
  const byId = new Map<string, MtTrade>()

  for (const trade of live) {
    if (accountIds && !accountIds.has(trade.broker_id)) continue
    byId.set(trade.id, trade)
  }

  for (const trade of cached) {
    if (trade.status !== 'closed') continue
    if (accountIds && !accountIds.has(trade.broker_id)) continue
    if (!byId.has(trade.id)) byId.set(trade.id, trade)
  }

  return [...byId.values()].sort(compareNewestFirst)
}
