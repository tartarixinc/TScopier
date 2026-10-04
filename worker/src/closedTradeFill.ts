import {
  resolveMtClosePrice,
  resolveMtCloseTimeMs,
  resolveMtLots,
  resolveMtPositionTicket,
  resolveMtStoredProfit,
  resolveMtText,
  resolveMtTicket,
  type MtHistoryProfile,
} from './mtTradeFields'

/** Closed trades still missing their broker fill (batch row shape).
 * `close_price`/`profit` are the columns as stored, so the planner can
 * refuse to rewrite a column that is already set. */
export type ClosedTradeFillRow = {
  id: string
  broker_account_id: string | null
  metaapi_order_id: string | null
  closed_at: string | null
  close_price: number | null
  profit: number | null
}

/** Fill values read from one closed deal: exit price and realized profit. */
export type ClosedTradeFill = {
  closePrice: number | null
  profit: number | null
}

/** Keyset cursor over `trades (closed_at desc, id desc)`. Compound because
 * basket/flatten closes share one `closed_at` — a single-column cursor would
 * permanently skip ties. */
export type ClosedFillCursor = { closedAt: string; id: string }

/** PostgREST `or=` filter for closed trades missing `close_price` or
 * `profit`. When a keyset cursor is supplied, each missing-fill test is
 * ANDed with the cursor inside a single `or=` so the cursor advances the
 * queue past permanently-unfillable rows without ever weakening the missing
 * test (two separate `.or()` params would not AND). Values are DB-sourced
 * timestamptz/uuid (type-constrained by Postgres) and URL-encoded by
 * supabase-js. */
export function missingFillFilter(cursor?: ClosedFillCursor | null): string {
  if (!cursor) return 'close_price.is.null,profit.is.null'
  const { closedAt, id } = cursor
  // Flattened `and()` operands (no nesting) — PostgREST parses these
  // unambiguously and the tie-break stays an AND of three conditions.
  return [
    `and(close_price.is.null,closed_at.lt.${closedAt})`,
    `and(close_price.is.null,closed_at.eq.${closedAt},id.lt.${id})`,
    `and(profit.is.null,closed_at.lt.${closedAt})`,
    `and(profit.is.null,closed_at.eq.${closedAt},id.lt.${id})`,
  ].join(',')
}

/** Cursor for the next tick: only a full batch has more rows below it, and
 * the anchor must be the oldest row actually seen (`closed_at` non-null —
 * never true in scope, the query filters NULLs out). */
export function nextClosedFillCursor(
  rows: ClosedTradeFillRow[],
  batchSize: number,
): ClosedFillCursor | null {
  if (rows.length < batchSize) return null
  const last = rows[rows.length - 1]
  if (!last?.closed_at) return null
  return { closedAt: last.closed_at, id: last.id }
}

/** States that mean the row was never a real fill: a cancelled or still-
 * pending order stays in OrderHistory with a close time. Executed rows
 * report "Started" or "Filled" on MTAPI (and the reader the dashboard uses
 * treats this as a blacklist), so this mirrors that check on the raw row. */
const NON_FILL_STATE_RE = /cancel|placed|pending|expired|deleted|reject/i

/** Non-trade history entries (deposit/withdrawal/credit/correction rows)
 * carry a ticket, a state and a profit — see the Balance row in
 * `docs/mtapi-conformance-sanitized.md`. Same stems the dashboard's
 * `isBalanceOpType` recognises, so the two reject the same rows. */
const NON_TRADE_KIND_RE = /balance|credit|deposit|withdraw|correction|transfer/i

/**
 * Structural gates for an MTAPI history row before any value is read — the
 * raw-row equivalent of the checks the dashboard's reader applies after
 * normalization (`fetchTradesListFromOrderHistory`), so the worker can only
 * ever persist what the dashboard would count as a closed leg:
 *
 * - a close time (MTAPI echoes open positions into OrderHistory regardless
 *   of the window; those carry no close time),
 * - a non-blacklisted state,
 * - a positive size and a symbol (drops the Balance row: `lots: 0`,
 *   `symbol: ""`),
 * - a non-trade entry type.
 *
 * Returns null when the row qualifies, else the reason — counted in the
 * optional `rejections` tally (the monitor logs it per tick, so a gate that
 * suddenly rejects everything shows up immediately after a deploy) and used
 * by the tests. A row missing the close time is rejected outright: without
 * it we cannot tell a fill from an open echo, and `profit` on an open
 * position is floating P/L, not realized P/L.
 */
export function mtCloseRowRejection(
  raw: Record<string, unknown>,
  profile: MtHistoryProfile,
): string | null {
  if (resolveMtCloseTimeMs(raw, profile) == null) return 'no-close-time'
  // Text fields are read through the flattened view (as `normalizeOrder`
  // does) so a value sitting on a nested deal object is still seen.
  const state = resolveMtText(raw, profile, 'state', 'State')
  if (state && NON_FILL_STATE_RE.test(state)) return 'state'
  if (resolveMtLots(raw, profile) <= 0) return 'lots'
  if (!resolveMtText(raw, profile, 'symbol', 'Symbol')) return 'symbol'
  const kind = `${resolveMtText(raw, profile, 'orderType', 'OrderType')} ${resolveMtText(
    raw,
    profile,
    'dealType',
    'DealType',
  )}`
  if (kind.trim() && NON_TRADE_KIND_RE.test(kind)) return 'non-trade'
  return null
}

/** FxSocket deal rows carry no `closePrice` key — the fill sits on `price`
 * (probe-verified against a live OrderHistory response). The caller gates on
 * the closing-deal shape first, so this only picks the price source. */
function fxsocketClosePrice(row: Record<string, unknown>, profile: MtHistoryProfile): number | null {
  const direct = resolveMtClosePrice(row, profile)
  if (direct != null) return direct
  const n = Number(row.price ?? row.Price)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Merge one history row's values into the entry for `key`. A later row
 * with only one of the two values must never destroy an earlier row's
 * other value — OrderHistory can repeat a ticket across pages (the
 * dashboard's own reader dedupes with `seen.has(ticket)`), and a clobber
 * would leave that trade permanently unfillable. */
function mergeFill(
  out: Map<number, ClosedTradeFill>,
  key: number,
  closePrice: number | null,
  profit: number | null,
): void {
  const prev = out.get(key)
  out.set(key, {
    closePrice: closePrice ?? prev?.closePrice ?? null,
    profit: profit ?? prev?.profit ?? null,
  })
}

/**
 * Index broker history rows by ticket → closed fill (exit price + realized
 * profit). Rows without a valid ticket and without any usable value are
 * skipped.
 *
 * The key differs by provider because the two bridges report different id
 * spaces (probe-verified):
 * - MTAPI rows are position-level: `trades.metaapi_order_id` equals the row's
 *   `ticket` (matches the edge's `normalizeOrder` output the dashboard uses).
 * - FxSocket `OrderHistory` rows are deal-level: `ticket` is the deal ticket,
 *   while `metaapi_order_id` equals `position`. Only the position-closing
 *   deal supplies the fill: the row must be a closing leg (`entry` contains
 *   "out") AND the closing deal itself (`order === 0`) — partial closes are
 *   execution prices for part of the position and must never be written as
 *   the trade's fill, so they are rejected outright; a batch without the
 *   closing deal (truncation or an unrecognised shape) leaves the trade null
 *   for a later retry or the 365-day age-out. The gate runs before any value
 *   is read, so a future shape with a fill on an open or balance row can
 *   never be accepted.
 *
 * The MTAPI path runs the same structural gates the dashboard's reader uses
 * (`mtCloseRowRejection`) before reading anything, because a non-fill row
 * that carries a profit would otherwise be written once and never corrected.
 *
 * Profit is read with `resolveMtStoredProfit` (netProfit ?? deal profit) —
 * the position-level net when the row reports one, else the deal profit.
 * See that helper's comment for how this relates to what the live dashboard
 * displays (same trade, not guaranteed byte-identical figure).
 */
export function extractClosedTradeFillsByTicket(
  rows: unknown[],
  profile: MtHistoryProfile,
  provider: string = 'mtapi',
  rejections?: Record<string, number>,
): Map<number, ClosedTradeFill> {
  const reject = (reason: string) => {
    if (rejections) rejections[reason] = (rejections[reason] ?? 0) + 1
  }
  const out = new Map<number, ClosedTradeFill>()
  if (provider === 'fxsocket') {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const raw = row as Record<string, unknown>
      const entry = String(raw.entry ?? raw.Entry ?? '').toLowerCase()
      if (!entry.includes('out')) continue
      if (Number(raw.order ?? raw.Order ?? 0) !== 0) continue
      const position = resolveMtPositionTicket(raw, profile)
      if (position == null || position <= 0) continue
      const closePrice = fxsocketClosePrice(raw, profile)
      const profit = resolveMtStoredProfit(raw, profile)
      if (closePrice == null && profit == null) continue
      mergeFill(out, position, closePrice, profit)
    }
    return out
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const raw = row as Record<string, unknown>
    const ticket = resolveMtTicket(raw, profile)
    if (ticket <= 0) continue
    const rejection = mtCloseRowRejection(raw, profile)
    if (rejection != null) {
      reject(rejection)
      continue
    }
    const closePrice = resolveMtClosePrice(raw, profile)
    const profit = resolveMtStoredProfit(raw, profile)
    if (closePrice == null && profit == null) continue
    mergeFill(out, ticket, closePrice, profit)
  }
  return out
}

/** One trade's fill patch; fields are present only when a value was found
 * *and* the stored column is still null. */
export type ClosedTradeFillUpdate = {
  id: string
  close_price?: number
  profit?: number
}

/** Match DB trades to extracted fills by ticket; only matched trades with at
 * least one usable value are planned, so unmatched trades stay null and are
 * retried on a later tick. A column that is already stored is never
 * rewritten: the value came from someone else (an admin edit, an earlier
 * tick) and this fill is not authoritative over it — and because the write
 * is one-shot, a wrong overwrite could never be repaired.
 * `trade.close_price`/`trade.profit` therefore have to be selected with the
 * batch for this to hold. */
export function planClosedTradeUpdates(
  trades: ClosedTradeFillRow[],
  fills: Map<number, ClosedTradeFill>,
): ClosedTradeFillUpdate[] {
  const updates: ClosedTradeFillUpdate[] = []
  for (const trade of trades) {
    const ticket = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue
    const fill = fills.get(ticket)
    if (!fill) continue
    const update: ClosedTradeFillUpdate = { id: trade.id }
    if (trade.close_price == null && fill.closePrice != null) update.close_price = fill.closePrice
    if (trade.profit == null && fill.profit != null) update.profit = fill.profit
    if (update.close_price === undefined && update.profit === undefined) continue
    updates.push(update)
  }
  return updates
}

/** True when the trade will still match the missing-fill filter after this
 * tick: a column was null on the row and no update carries a value for it.
 * Drives both the tally (a write that leaves a column null is progress, not
 * completion) and the attempt ledger below. */
export function stillMissingFill(
  trade: ClosedTradeFillRow,
  update: ClosedTradeFillUpdate | undefined,
): boolean {
  if (trade.close_price == null && update?.close_price === undefined) return true
  if (trade.profit == null && update?.profit === undefined) return true
  return false
}

/** What one trade's outcome means for the attempt ledger and the tally.
 * - `hit`: progress was made (a column was written) but the row still needs
 *   another column — forget the strike count, keep it in the batch;
 * - `cleared`: the row left the missing-fill filter — forget it and count it
 *   as filled;
 * - `miss`: the read was `readable` and found nothing usable — one strike;
 * - `retry`: nothing found, but the read was NOT readable (empty response,
 *   truncated page walk, trade outside the covered range) — no strike, no
 *   progress, and no write attempt.
 *
 * `readable` is the whole point of the split: a strike only ever comes from
 * a read that could have seen this trade's fill. Firing it from a truncated
 * or empty read would drop the row after `missLimit` ticks and its P/L would
 * never be written. */
export function classifyFillOutcome(
  trade: ClosedTradeFillRow,
  update: ClosedTradeFillUpdate | undefined,
  landed: boolean,
  readable: boolean,
): 'hit' | 'cleared' | 'miss' | 'retry' {
  if (!update) return readable ? 'miss' : 'retry'
  const stillMissing = stillMissingFill(trade, update)
  if (landed) return stillMissing ? 'hit' : 'cleared'
  // Nothing was written: either the guard matched nothing (a concurrent
  // writer got there first — if nothing is left the row is done) or the
  // write reported no row.
  return stillMissing ? (readable ? 'miss' : 'retry') : 'cleared'
}

/** Slack above the page-cap boundary. DB `closed_at` runs at or AFTER the
 * bridge's own close time (observed lag up to ~22.3 h), so a trade whose
 * bridge fill sits below the boundary — unread — can still report a
 * `closed_at` above it. Only `closed_at >= boundary + 24 h` guarantees the
 * fill was inside the fetched pages (`bridge close >= closed_at − 22.3 h >=
 * boundary + 1.7 h`). The band between the boundary and boundary + 24 h is
 * deliberately never struck: conservative, at the cost of a few extra ticks. */
export const COVERAGE_MARGIN_MS = 24 * 60 * 60 * 1000

/** Oldest close time among the history rows actually fetched — the boundary
 * a capped page walk established. The cap keeps the NEWEST pages (page
 * indices ascend with time; the walk fetches them newest-first), so the
 * minimum close time over the fetched set is the edge of the covered
 * region: rows older than it were not read. Null when no row carries a
 * usable close time (then the boundary is unknown and nothing may be
 * claimed). */
function oldestCoveredCloseMs(rows: unknown[]): number | null {
  let oldest: number | null = null
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const ms = resolveMtCloseTimeMs(row as Record<string, unknown>, 'trades')
    if (ms == null) continue
    if (oldest == null || ms < oldest) oldest = ms
  }
  return oldest
}

/**
 * Whether a history read may speak for a given trade — the single decision
 * the attempt ledger depends on (so it lives here, in unit-testable form).
 *
 * A predicate that answers `true` allows one strike when nothing usable was
 * found; `false` leaves the row for a later tick. It answers `false` when:
 * - the response was empty — a bridge answering `200 []` while its session
 *   is still syncing proves nothing about any individual trade;
 * - a deadline cut the walk — pages the reader never reached;
 * - the 40-page cap engaged (`pageCapEngaged`) and the trade's `closed_at`
 *   is below `oldestCoveredCloseMs(rows) + marginMs`, i.e. its fill may sit
 *   in the unread region (see `COVERAGE_MARGIN_MS` for the arithmetic);
 * - no row established a usable boundary.
 *
 * Everything else (full-window reads, single-call readers) covers the whole
 * batch.
 */
export function historyCoverage(
  rows: unknown[],
  opts: {
    deadlineHit?: boolean
    pageCapEngaged?: boolean
    marginMs?: number
  } = {},
): (trade: ClosedTradeFillRow) => boolean {
  const {
    deadlineHit = false,
    pageCapEngaged = false,
    marginMs = COVERAGE_MARGIN_MS,
  } = opts
  if (deadlineHit || rows.length === 0) return () => false
  if (!pageCapEngaged) return () => true
  const boundary = oldestCoveredCloseMs(rows)
  if (boundary == null) return () => false
  const floorMs = boundary + marginMs
  return trade => trade.closed_at != null && Date.parse(trade.closed_at) >= floorMs
}

/**
 * Per-row record of "fetched history and found nothing". A trade whose
 * broker history never contains the fill (stranded broker, vanished ticket)
 * would otherwise be re-selected forever, costing a history read on every
 * active tick; after `missLimit` fruitless ticks the row is dropped from the
 * batch so the loop only pays for rows it can still make progress on. The
 * set is bounded: on overflow it resets, giving every row another chance to
 * be retried. A hit (the trade left the filter, or a write made progress)
 * forgets the row.
 *
 * The caller must only record a `miss` for a read that says it COULD have
 * seen this trade's fill (`covers(trade)` in the monitor): a read cut short
 * by a deadline, truncated by the page cap, or returning nothing proves
 * nothing about the trade, and a miss counted for it would skip a fill that
 * a later tick could have written. That is also why the limit can sit at 10
 * — an extra tick is one shared broker read for the whole batch, while a
 * wrongly skipped trade silently loses its P/L for good. Reads that prove
 * nothing are recorded separately as `uncovered` against a much larger
 * budget, so such a row still eventually leaves the batch instead of being
 * re-read forever.
 */
export class FillAttempts {
  private readonly misses = new Map<string, number>()
  private readonly uncoveredCounts = new Map<string, number>()

  /** `maxTracked` is applied per ledger (each map resets independently), so
   * `tracked` — the sum of both — can reach twice that figure. */
  constructor(
    private readonly missLimit: number = 10,
    private readonly maxTracked: number = 5_000,
    private readonly uncoveredLimit: number = 100,
  ) {}

  pending(rows: ClosedTradeFillRow[]): ClosedTradeFillRow[] {
    return rows.filter(
      row =>
        (this.misses.get(row.id) ?? 0) < this.missLimit &&
        (this.uncoveredCounts.get(row.id) ?? 0) < this.uncoveredLimit,
    )
  }

  /** A read that could have seen this trade's fill and found nothing — the
   * expensive, precise strike, budgeted tightly (`missLimit`). */
  miss(id: string): void {
    this.misses.set(id, (this.misses.get(id) ?? 0) + 1)
    if (this.misses.size > this.maxTracked) this.misses.clear()
  }

  /** A read that could NOT speak for this trade (empty response, deadline
   * cut, page cap left it in the unread region). These must not cost the row
   * its P/L, but they also cannot run forever: a permanently uncoverable row
   * would otherwise be re-read on every active tick until it ages out of the
   * 365-day window. Given a much larger budget (`uncoveredLimit`) so a
   * merely-slow read gets plenty of slack while a truly unreachable row
   * still eventually leaves the batch. */
  uncovered(id: string): void {
    this.uncoveredCounts.set(id, (this.uncoveredCounts.get(id) ?? 0) + 1)
    if (this.uncoveredCounts.size > this.maxTracked) this.uncoveredCounts.clear()
  }

  /** Progress (a landed write, or the row left the filter) resets both
   * budgets — the row proved it can move again. */
  hit(id: string): void {
    this.misses.delete(id)
    this.uncoveredCounts.delete(id)
  }

  get tracked(): number {
    return this.misses.size + this.uncoveredCounts.size
  }
}

/**
 * Counter arithmetic for one broker's slice of a batch (the monitor's tally,
 * in unit-testable form). Every trade in the slice lands in exactly one
 * bucket:
 * - `filled`: the trade left the missing-fill filter (all of its null
 *   columns now have a value, whether written here or concurrently),
 * - `pending`: still null after this tick — no history match, a partially
 *   filled row, or a write that failed (retried on the next tick),
 * - `errors`: writes that failed outright, a subset of `pending` reported
 *   separately so a failing bridge is visible.
 */
export function tallyBrokerBatch(
  batchSize: number,
  filledTrades: number,
  updateErrors: number,
): { filled: number; pending: number; errors: number } {
  const filled = Math.max(0, Math.min(filledTrades, batchSize))
  return {
    filled,
    pending: batchSize - filled,
    errors: updateErrors,
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
  trades: ClosedTradeFillRow[],
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
