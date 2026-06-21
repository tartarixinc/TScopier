import type { SupabaseClient } from '@supabase/supabase-js'
import { hasFxsocketConfigured, type FxsocketBrokerClient } from './fxsocketClient'
import { apiForFxsocketAccount, brokerSessionId, loadPlatformByFxsocketId } from './mtApiByAccount'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { stopRangeLayeringUnlessEnabled } from './rangeLayerTillClose'
import { isUserCopierPausedCached } from './copierPause'

/**
 * Worker-side monitor that closes "Close-Worse-Entries" positions once the
 * live /Quote crosses their CWE threshold.
 *
 * Background — why a worker monitor instead of a broker takeprofit:
 *   The old design stamped `takeprofit = anchor ± cwePips × pip` on every
 *   CWE-eligible leg. That repeatedly produced "Invalid stops" rejections
 *   from MT5 because:
 *     - On XAUUSD inside the broker's stops/freeze zone the TP fell too
 *       close to market and was refused.
 *     - When the basket was already in profit (the common case for
 *       averaging-down legs that fill late) the TP was on the wrong side
 *       of market and was refused.
 *   Moving the close decision to the worker sidesteps both issues — we
 *   compare a number to a live quote and call /OrderClose, no broker
 *   stops_level / freeze_level / side constraints apply.
 *
 * Trigger semantics:
 *   buy  → close when bid  >= cwe_close_price   (long basket reached +X pips profit)
 *   sell → close when ask  <= cwe_close_price   (short basket reached +X pips profit)
 *
 * Failure handling: a /OrderClose that returns "trade not found" / "already
 * closed" is treated as success — the trade is updated to status='closed'
 * and cwe_close_price is cleared. Any other error leaves the row in place
 * for the next tick to retry. We never throw out of the tick loop.
 *
 * Cadence: 1.5s, same as VirtualPendingMonitor. Cheap because the partial
 * index `trades_cwe_open_idx` keeps the working set tiny — most signals
 * have no CWE basket, and the basket clears on first hit.
 */

interface CweTradeRow {
  id: string
  user_id: string
  signal_id: string | null
  broker_account_id: string | null
  metaapi_order_id: string | null
  symbol: string
  direction: 'buy' | 'sell' | string
  lot_size: number | null
  cwe_close_price: number
}

interface BrokerRow {
  id: string
  fxsocket_account_id: string | null
  metaapi_account_id: string | null
  platform: string
}

const ACTIVE_MS = monitorActiveIntervalMs('CWE_CLOSE_TICK_MS', 400)
const IDLE_MS = monitorIdleIntervalMs('CWE_CLOSE_IDLE_MS', 15_000)

/**
 * Pure trigger check. Exported so the unit test can lock the
 * direction-aware comparison without spinning up a Supabase client.
 *
 *   buy  → close when bid  >= threshold
 *   sell → close when ask  <= threshold
 *
 * Returns false on NaN / non-finite inputs so a flaky /Quote can't ever
 * cause a spurious close.
 */
export function isCweTriggered(direction: 'buy' | 'sell' | string, threshold: number, bid: number, ask: number): boolean {
  if (!Number.isFinite(threshold) || threshold <= 0) return false
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false
  const isBuy = String(direction).toLowerCase() === 'buy'
  return isBuy ? bid >= threshold : ask <= threshold
}

export class CweCloseMonitor {
  private loop: MonitorLoopHandle | null = null
  private ticking = false
  private firstTickLogged = false
  /** Heartbeat: log one summary line every ~30s (20 ticks × 1.5s) when there
   *  are watched trades but none have triggered. Makes "alive but waiting"
   *  visible in worker logs vs. "dead". */
  private quietTicks = 0

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    if (!hasFxsocketConfigured()) {
      console.warn('[cweCloseMonitor] MT4API_BASIC_USER/PASSWORD missing — close-worse-entries monitor disabled')
      return
    }
    this.loop = startMonitorLoop({
      name: 'cweCloseMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: sb => hasWorkOnShard(sb, 'trades', q =>
        q.eq('status', 'open').not('cwe_close_price', 'is', null),
      ),
      tick: () => this.runTick(),
    })
    console.log(`[cweCloseMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
  }

  stop() {
    this.loop?.stop()
    this.loop = null
  }

  getLoopHandle(): MonitorLoopHandle | null {
    return this.loop
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tick()
    } finally {
      this.ticking = false
    }
  }

  private async tick(): Promise<void> {
    if (!hasFxsocketConfigured()) return

    // Pull every open trade that has a CWE close threshold pinned to it.
    // The partial index `trades_cwe_open_idx` makes this a constant-time
    // probe even with millions of historical trades on the table.
    const tradesQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('trades')
        .select('id,user_id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,cwe_close_price')
        .eq('status', 'open')
        .not('cwe_close_price', 'is', null)
        .limit(500),
    )
    if (!tradesQ) return
    const { data, error } = await tradesQ
    if (error) {
      console.error('[cweCloseMonitor] select failed:', error.message)
      return
    }
    const rows = ((data ?? []) as CweTradeRow[])
      .filter(r => !isUserCopierPausedCached(r.user_id))
    if (!this.firstTickLogged) {
      this.firstTickLogged = true
      console.log(`[cweCloseMonitor] first tick ok watched_rows=${rows.length}`)
    }
    if (!rows.length) {
      this.quietTicks = 0
      return
    }

    // Resolve each broker_account_id once so we can call /Quote and
    // /OrderClose by FxSocket terminal UUID. Trades that reference a deleted
    // broker silently skip.
    const brokerIds = Array.from(new Set(rows.map(r => r.broker_account_id).filter((x): x is string => !!x)))
    const brokerMap = new Map<string, string>() // broker_account_id -> fxsocket session id
    if (brokerIds.length > 0) {
      const { data: brokers, error: brokerErr } = await this.supabase
        .from('broker_accounts')
        .select('id,fxsocket_account_id,metaapi_account_id,platform')
        .in('id', brokerIds)
      if (brokerErr) {
        console.error('[cweCloseMonitor] broker lookup failed:', brokerErr.message)
        return
      }
      for (const b of (brokers ?? []) as BrokerRow[]) {
        const sessionId = brokerSessionId(b)
        if (sessionId) brokerMap.set(b.id, sessionId)
      }
    }
    const platformByUuid = await loadPlatformByFxsocketId(
      this.supabase,
      Array.from(brokerMap.values()),
    )

    // Group by (fxsocket session id, symbol) so we issue at most ONE /Quote per
    // group per tick. Same shape as virtualPendingMonitor for consistency.
    const groups = new Map<string, CweTradeRow[]>()
    for (const r of rows) {
      const uuid = r.broker_account_id ? brokerMap.get(r.broker_account_id) : null
      if (!uuid) continue
      const key = `${uuid}|${r.symbol}`
      const list = groups.get(key) ?? []
      list.push(r)
      groups.set(key, list)
    }

    let triggeredTotal = 0
    let closedOkTotal = 0
    let closedErrTotal = 0
    /** Per-group: nearest distance from live quote to any threshold (so the
     *  heartbeat shows "you're $0.40 from your nearest CWE close"). */
    const distances: Array<{ symbol: string; bid: number; ask: number; gap: number; legs: number }> = []

    await Promise.all(Array.from(groups.entries()).map(async ([key, trades]) => {
      const [uuid, symbol] = key.split('|')
      if (!uuid || !symbol) return
      const api = apiForFxsocketAccount(platformByUuid, uuid)
      if (!api) return
      let q
      try {
        q = await api.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[cweCloseMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`)
        return
      }

      let nearestGap = Number.POSITIVE_INFINITY
      for (const trade of trades) {
        const isBuy = String(trade.direction).toLowerCase() === 'buy'
        const ref = isBuy ? q.bid : q.ask
        // For buys: positive gap means bid still BELOW threshold (waiting for rise).
        // For sells: positive gap means ask still ABOVE threshold (waiting for fall).
        const gap = isBuy ? trade.cwe_close_price - ref : ref - trade.cwe_close_price
        if (Number.isFinite(gap) && gap < nearestGap) nearestGap = gap
        if (!isCweTriggered(trade.direction, trade.cwe_close_price, q.bid, q.ask)) continue
        triggeredTotal += 1
        const ok = await this.closeTrade(trade, uuid, api, q.bid, q.ask)
        if (ok) closedOkTotal += 1
        else closedErrTotal += 1
      }
      distances.push({ symbol, bid: q.bid, ask: q.ask, gap: nearestGap, legs: trades.length })
    }))

    if (triggeredTotal > 0) {
      console.log(
        `[cweCloseMonitor] tick rows=${rows.length} groups=${groups.size} triggered=${triggeredTotal} closed=${closedOkTotal}_ok ${closedErrTotal}_err`,
      )
      this.quietTicks = 0
    } else {
      this.quietTicks += 1
      if (this.quietTicks % 20 === 1) {
        const summary = distances
          .map(d => `${d.symbol} bid=${d.bid} ask=${d.ask} nearest_gap=${Number.isFinite(d.gap) ? d.gap.toFixed(5) : 'n/a'} (${d.legs} legs)`)
          .join('; ')
        console.log(
          `[cweCloseMonitor] heartbeat rows=${rows.length} groups=${groups.size} no thresholds crossed yet — ${summary}`,
        )
      }
    }
  }

  /**
   * Attempt to close one CWE-watched trade. Returns true on success (or when
   * the broker reports the trade is already gone — same outcome). Failures
   * leave the row in place so the next tick retries.
   *
   * Concurrency note: we CAS-update `cwe_close_price` to null BEFORE calling
   * /OrderClose. If a second tick (or a peer worker) grabs the same row, the
   * update returns no row and this function bails — only one /OrderClose
   * ever lands per ticket.
   */
  private async closeTrade(
    trade: CweTradeRow,
    uuid: string,
    api: FxsocketBrokerClient,
    bid: number,
    ask: number,
  ): Promise<boolean> {
    const ticketNum = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
      // Missing ticket — nothing for us to close. Clear the watch so we
      // don't keep retrying on every tick.
      await this.supabase.from('trades').update({ cwe_close_price: null }).eq('id', trade.id)
      return false
    }

    // CAS claim: clear the cwe_close_price so a second tick or a peer worker
    // can't issue a duplicate /OrderClose. The `.maybeSingle()` returns
    // null when the row already moved (another tick won the race).
    const { data: claimed, error: claimErr } = await this.supabase
      .from('trades')
      .update({ cwe_close_price: null })
      .eq('id', trade.id)
      .eq('status', 'open')
      .not('cwe_close_price', 'is', null)
      .select('id')
      .maybeSingle()
    if (claimErr) {
      console.warn(`[cweCloseMonitor] CAS claim error trade=${trade.id}: ${claimErr.message}`)
      return false
    }
    if (!claimed) {
      // Someone else claimed it. Quiet — this is expected when multiple
      // workers are deployed for redundancy.
      return false
    }

    const t0 = Date.now()
    const isBuy = String(trade.direction).toLowerCase() === 'buy'
    const refPrice = isBuy ? bid : ask
    try {
      const result = await api.orderClose(uuid, {
        ticket: ticketNum,
        lots: trade.lot_size ?? 0,
        // Leaving price=0 lets the broker fill at market — same behavior as
        // a manual close from the terminal. We *report* refPrice in logs for
        // diagnostics only.
      })
      const latencyMs = Date.now() - t0
      console.log(
        `[cweCloseMonitor] closed signal=${trade.signal_id ?? 'n/a'} symbol=${trade.symbol} ticket=${ticketNum}`
        + ` threshold=${trade.cwe_close_price} ref=${refPrice} latency=${latencyMs}ms`,
      )
      await this.supabase
        .from('trades')
        .update({ status: 'closed', closed_at: new Date().toISOString() })
        .eq('id', trade.id)
      await this.supabase.from('trade_execution_logs').insert({
        user_id: trade.user_id,
        signal_id: trade.signal_id,
        broker_account_id: trade.broker_account_id,
        action: 'cwe_close',
        status: 'success',
        request_payload: {
          ticket: ticketNum,
          symbol: trade.symbol,
          direction: trade.direction,
          threshold: trade.cwe_close_price,
          ref_price: refPrice,
        } as unknown as Record<string, unknown>,
        response_payload: { ticket: result.ticket, latency_ms: latencyMs },
      })
      if (trade.signal_id && trade.broker_account_id) {
        await stopRangeLayeringUnlessEnabled(
          this.supabase,
          {
            signalId: trade.signal_id,
            brokerAccountId: trade.broker_account_id,
            symbol: trade.symbol,
            userId: trade.user_id,
          },
          'cwe_close',
        )
      }
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // "trade not found" / "position already closed" — treat as success,
      // the trade is gone either way. Conservative match list so we never
      // swallow a real error.
      const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg)
      if (benign) {
        console.log(
          `[cweCloseMonitor] trade already gone signal=${trade.signal_id ?? 'n/a'} ticket=${ticketNum}: ${msg}`,
        )
        await this.supabase
          .from('trades')
          .update({ status: 'closed', closed_at: new Date().toISOString() })
          .eq('id', trade.id)
        if (trade.signal_id && trade.broker_account_id) {
          await stopRangeLayeringUnlessEnabled(
            this.supabase,
            {
              signalId: trade.signal_id,
              brokerAccountId: trade.broker_account_id,
              symbol: trade.symbol,
              userId: trade.user_id,
            },
            'cwe_close_benign',
          )
        }
        return true
      }
      console.error(
        `[cweCloseMonitor] close failed signal=${trade.signal_id ?? 'n/a'} ticket=${ticketNum}: ${msg}`,
      )
      // Restore the watch so a future tick can retry. Without this the trade
      // would stay open but un-watched forever after a transient /OrderClose
      // failure.
      await this.supabase
        .from('trades')
        .update({ cwe_close_price: trade.cwe_close_price })
        .eq('id', trade.id)
        .eq('status', 'open')
      await this.supabase.from('trade_execution_logs').insert({
        user_id: trade.user_id,
        signal_id: trade.signal_id,
        broker_account_id: trade.broker_account_id,
        action: 'cwe_close',
        status: 'failed',
        request_payload: {
          ticket: ticketNum,
          symbol: trade.symbol,
          direction: trade.direction,
          threshold: trade.cwe_close_price,
          ref_price: refPrice,
        } as unknown as Record<string, unknown>,
        error_message: msg,
      })
      return false
    }
  }
}
