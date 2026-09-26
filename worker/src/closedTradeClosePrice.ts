import { resolveMtClosePrice, resolveMtPositionTicket, resolveMtTicket, type MtHistoryProfile } from './mtTradeFields'

/** Closed trades still missing their close price (batch row shape). */
export type ClosedTradeClosePriceRow = {
  id: string
  broker_account_id: string | null
  metaapi_order_id: string | null
  closed_at: string | null
}

/** Keyset cursor over `trades (closed_at desc, id desc)`. Compound because
 * basket/flatten closes share one `closed_at` — a single-column cursor would
 * permanently skip ties. */
export type ClosePriceCursor = { closedAt: string; id: string }

/** PostgREST `or=` filter that is strictly after the cursor in
 * `(closed_at desc, id desc)` order. Values are DB-sourced timestamptz/uuid
 * (type-constrained by Postgres) and URL-encoded by supabase-js. */
export function closePriceKeysetFilter(cursor: ClosePriceCursor): string {
  return `closed_at.lt.${cursor.closedAt},and(closed_at.eq.${cursor.closedAt},id.lt.${cursor.id})`
}

/** Cursor for the next tick: only a full batch has more rows below it, and
 * the anchor must be the oldest row actually seen (`closed_at` non-null —
 * never true in scope, the query filters NULLs out). */
export function nextClosePriceCursor(
  rows: ClosedTradeClosePriceRow[],
  batchSize: number,
): ClosePriceCursor | null {
  if (rows.length < batchSize) return null
  const last = rows[rows.length - 1]
  if (!last?.closed_at) return null
  return { closedAt: last.closed_at, id: last.id }
}

/** FxSocket deal rows carry no `closePrice` key — the fill sits on `price`
 * (probe-verified, see docs/scratchpads/scratchpad-close-price-backfill-2026-09-26.md).
 * The caller gates on the closing-deal shape first, so this only picks the
 * price source. */
function fxsocketClosePrice(row: Record<string, unknown>, profile: MtHistoryProfile): number | null {
  const direct = resolveMtClosePrice(row, profile)
  if (direct != null) return direct
  const n = Number(row.price ?? row.Price)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Index broker history rows by ticket → close price. Rows without a valid
 * ticket or without a positive close price are skipped.
 *
 * The key differs by provider because the two bridges report different id
 * spaces (probe-verified):
 * - MTAPI rows are position-level: `trades.metaapi_order_id` equals the row's
 *   `ticket` (matches the edge's `normalizeOrder` output the dashboard uses).
 * - FxSocket `OrderHistory` rows are deal-level: `ticket` is the deal ticket,
 *   while `metaapi_order_id` equals `position`. Only the position-closing
 *   deal supplies a fill: the row must be a closing leg (`entry` contains
 *   "out") AND the closing deal itself (`order === 0`) — partial closes are
 *   execution prices for part of the position and must never be written as
 *   the trade's close price, so they are rejected outright; a batch without
 *   the closing deal (truncation or an unrecognised shape) leaves the trade
 *   null for a later retry or the 365-day age-out. The gate runs before any
 *   price is read, so a future shape with `closePrice` on an open or balance
 *   row can never be accepted.
 */
export function extractClosePricesByTicket(
  rows: unknown[],
  profile: MtHistoryProfile,
  provider: string = 'mtapi',
): Map<number, number> {
  const out = new Map<number, number>()
  if (provider === 'fxsocket') {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const raw = row as Record<string, unknown>
      const entry = String(raw.entry ?? raw.Entry ?? '').toLowerCase()
      if (!entry.includes('out')) continue
      if (Number(raw.order ?? raw.Order ?? 0) !== 0) continue
      const position = resolveMtPositionTicket(raw, profile)
      if (position == null || position <= 0) continue
      const price = fxsocketClosePrice(raw, profile)
      if (price == null) continue
      out.set(position, price)
    }
    return out
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const ticket = resolveMtTicket(row as Record<string, unknown>, profile)
    if (ticket <= 0) continue
    const price = resolveMtClosePrice(row as Record<string, unknown>, profile)
    if (price == null || price <= 0) continue
    out.set(ticket, price)
  }
  return out
}

/** Match DB trades to extracted prices by ticket; only matched pairs are
 * written, so unmatched trades stay null and are retried on a later tick. */
export function planClosePriceUpdates(
  trades: ClosedTradeClosePriceRow[],
  priceByTicket: Map<number, number>,
): Array<{ id: string; close_price: number }> {
  const updates: Array<{ id: string; close_price: number }> = []
  for (const trade of trades) {
    const ticket = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue
    const price = priceByTicket.get(ticket)
    if (price == null) continue
    updates.push({ id: trade.id, close_price: price })
  }
  return updates
}

/**
 * Counter arithmetic for one broker's slice of a batch (the monitor's tally,
 * in unit-testable form). Everything in the slice that was not successfully
 * written counts as unmatched: trades that never matched a history row plus
 * planned updates whose write failed. Confirmed writes count as filled;
 * fetch failures are the caller's `skipped`, not part of this.
 */
export function tallyBrokerBatch(
  batchSize: number,
  plannedUpdates: number,
  confirmedFills: number,
  updateErrors: number,
): { filled: number; unmatched: number } {
  return {
    filled: confirmedFills,
    unmatched: batchSize - plannedUpdates + updateErrors,
  }
}

/**
 * History window covering every trade in the batch: three days before the
 * earliest close, up to three days past the latest close in the batch (both
 * bridges return rows whose close/deal time runs at or before the DB
 * `closed_at` — observed lag up to ~22.3 h, so a 3-day margin leaves ~50 h
 * of headroom before a trade could fall outside the window on every tick;
 * anchoring at the batch instead of `now` keeps year-old batches from
 * asking the bridge for a year of history). Falls back to `now` when the
 * batch has no parseable close time. Naive `yyyy-MM-ddTHH:mm:ss` bounds —
 * the exact format every other OrderHistory caller sends
 * (`formatMtApiDateTime`); the bridge does not accept the full RFC3339
 * `…sssZ` form.
 */
export function historyWindow(
  trades: ClosedTradeClosePriceRow[],
  nowMs: number = Date.now(),
): { from: string; to: string } {
  const marginMs = 3 * 24 * 60 * 60 * 1000
  let earliestMs = nowMs
  let latestMs = Number.NaN
  for (const trade of trades) {
    const closedMs = trade.closed_at ? Date.parse(trade.closed_at) : NaN
    if (!Number.isFinite(closedMs)) continue
    if (closedMs < earliestMs) earliestMs = closedMs
    if (!Number.isFinite(latestMs) || closedMs > latestMs) latestMs = closedMs
  }
  const toMs = Number.isFinite(latestMs) ? latestMs : nowMs
  const naiveIso = (ms: number) => new Date(ms).toISOString().slice(0, 19)
  return {
    from: naiveIso(earliestMs - marginMs),
    to: naiveIso(toMs + marginMs),
  }
}
