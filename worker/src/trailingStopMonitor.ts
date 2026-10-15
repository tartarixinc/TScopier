import type { SupabaseClient } from '@supabase/supabase-js'
import { TRADE_CLOSE_REASON } from './tradeCloseReasons'
import { applyCloseUpdate } from './tradeCloseUpdate'
import { signalPipPrice } from './signalPip'
import {
  computeTrailingStopUpdate,
  normalizeTrailingConfig,
  type TrailingStopConfig,
} from './trailingStop'
import {
  normalizeSymbolParams,
  type FxsocketBrokerClient,
  type SymbolParams,
} from './fxsocketClient'
import {
  brokerRuntimeForAccount,
  loadBrokerApiByAccountId,
  type BrokerApiByAccountId,
} from './mtApiByAccount'
import { isBenignOrderModifyError } from './orderModifyBenign'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { isUserCopierPausedCached } from './copierPause'
import { writeExecutionLog } from './observability/executionLog'
interface TrailTradeRow {
  id: string
  user_id: string
  signal_id: string | null
  broker_account_id: string | null
  metaapi_order_id: string | null
  broker_position_ticket?: string | null
  symbol: string
  direction: string
  entry_price: number | null
  sl: number | null
  tp: number | null
  trail_peak_price: number
  trail_last_sl: number | null
  trail_start_pips: number | null
  trail_step_pips: number | null
  trail_distance_pips: number | null
}

const ACTIVE_MS = monitorActiveIntervalMs('TRAILING_STOP_TICK_MS', 400)
const IDLE_MS = monitorIdleIntervalMs('TRAILING_STOP_IDLE_MS', 15_000)
const SYMBOL_CACHE_TTL_MS = 5 * 60_000

type SymbolCacheEntry = {
  digits: number
  point: number
  contractSize: number | null
  loadedAt: number
}

export class TrailingStopMonitor {
  private loop: MonitorLoopHandle | null = null
  private runtimeByBroker: BrokerApiByAccountId = new Map()
  private ticking = false
  private firstTickLogged = false
  private quietTicks = 0
  private symbolCache = new Map<string, SymbolCacheEntry>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    this.loop = startMonitorLoop({
      name: 'trailingStopMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: sb => hasWorkOnShard(sb, 'trades', q =>
        q.eq('status', 'open').not('trail_peak_price', 'is', null),
      ),
      tick: () => this.runTick(),
    })
    console.log(`[trailingStopMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
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
    const tradesQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('trades')
        .select(
          'id,user_id,signal_id,broker_account_id,metaapi_order_id,broker_position_ticket,symbol,direction,entry_price,sl,tp,'
          + 'trail_peak_price,trail_last_sl,trail_start_pips,trail_step_pips,trail_distance_pips',
        )
        .eq('status', 'open')
        .not('trail_peak_price', 'is', null)
        .limit(500),
    )
    if (!tradesQ) return
    const { data, error } = await tradesQ
    if (error) {
      console.error('[trailingStopMonitor] select failed:', error.message)
      return
    }
    const rows = ((data ?? []) as unknown as TrailTradeRow[])
      .filter(r => !isUserCopierPausedCached(r.user_id))
    if (!this.firstTickLogged) {
      this.firstTickLogged = true
      console.log(`[trailingStopMonitor] first tick ok trail_rows=${rows.length}`)
    }
    if (!rows.length) return

    const brokerIds = [...new Set(rows.map(r => r.broker_account_id).filter(Boolean))] as string[]
    this.runtimeByBroker = await loadBrokerApiByAccountId(this.supabase, brokerIds)

    const groups = new Map<string, TrailTradeRow[]>()
    for (const row of rows) {
      const brokerId = String(row.broker_account_id ?? '')
      if (!this.runtimeByBroker.has(brokerId)) continue
      const key = `${brokerId}|${row.symbol.toUpperCase()}`
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
    }

    let modifiedTotal = 0
    let modifyErrTotal = 0
    for (const [key, group] of groups) {
      const brokerId = key.split('|')[0]!
      const symbol = group[0]?.symbol ?? ''
      const runtime = brokerRuntimeForAccount(this.runtimeByBroker, brokerId)
      if (!runtime) continue
      const uuid = runtime.sessionId
      const api = runtime.api
      let bid = NaN
      let ask = NaN
      try {
        const q = await api.quote(uuid, symbol)
        bid = q.bid
        ask = q.ask
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[trailingStopMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`)
        continue
      }

      for (const trade of group) {
        const ok = await this.maybeTrailTrade(trade, uuid, api, bid, ask)
        if (ok === true) modifiedTotal++
        if (ok === false) modifyErrTotal++
      }
    }

    if (modifiedTotal > 0 || modifyErrTotal > 0) {
      this.quietTicks = 0
      console.log(
        `[trailingStopMonitor] tick rows=${rows.length} groups=${groups.size} trailed=${modifiedTotal} errors=${modifyErrTotal}`,
      )
    } else if (++this.quietTicks >= 20) {
      this.quietTicks = 0
      console.log(`[trailingStopMonitor] heartbeat rows=${rows.length} groups=${groups.size} (no SL updates this cycle)`)
    }
  }

  private async maybeTrailTrade(
    trade: TrailTradeRow,
    uuid: string,
    api: FxsocketBrokerClient,
    bid: number,
    ask: number,
  ): Promise<boolean | null> {
    const ticketNum = Number(trade.broker_position_ticket ?? trade.metaapi_order_id)
    if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
      await this.clearTrailWatch(trade.id)
      return null
    }

    const entry = Number(trade.entry_price)
    const peak = Number(trade.trail_peak_price)
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(peak) || peak <= 0) {
      return null
    }

    const symEntry = await this.getSymbolCache(uuid, trade.symbol, api)
    if (!symEntry) return null

    const signalPip = signalPipPrice(trade.symbol)
    const config: TrailingStopConfig = normalizeTrailingConfig({
      trailing_start_pips: trade.trail_start_pips ?? undefined,
      trailing_step_pips: trade.trail_step_pips ?? undefined,
      trailing_distance_pips: trade.trail_distance_pips ?? undefined,
    })

    const isBuy = String(trade.direction).toLowerCase() === 'buy'
    const currentSl = trade.trail_last_sl ?? trade.sl
    const update = computeTrailingStopUpdate({
      isBuy,
      entryPrice: entry,
      currentSl: currentSl != null ? Number(currentSl) : null,
      trailPeak: peak,
      bid,
      ask,
      pipPrice: signalPip,
      digits: symEntry.digits,
      config,
    })
    if (!update) return null

    const tpSanitize = trade.tp != null && Number.isFinite(Number(trade.tp)) && Number(trade.tp) > 0
      ? Number(trade.tp)
      : 0

    try {
      await api.orderModify(uuid, {
        ticket: ticketNum,
        stoploss: update.newSl,
        takeprofit: tpSanitize,
      })
      await this.supabase
        .from('trades')
        .update({
          sl: update.newSl,
          trail_peak_price: update.newPeak,
          trail_last_sl: update.newSl,
        })
        .eq('id', trade.id)
        .eq('status', 'open')
      await writeExecutionLog(this.supabase, {
        user_id: trade.user_id,
        signal_id: trade.signal_id,
        broker_account_id: trade.broker_account_id,
        action: 'trailing_stop',
        status: 'success',
        request_payload: {
          ticket: ticketNum,
          symbol: trade.symbol,
          direction: trade.direction,
          new_sl: update.newSl,
          trail_peak: update.newPeak,
          profit_pips: update.profitPips,
        } as unknown as Record<string, unknown>,
      })
      console.log(
        `[trailingStopMonitor] trailed trade=${trade.id} symbol=${trade.symbol} sl→${update.newSl} peak=${update.newPeak}`,
      )
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order|unknown\s+ticket/i.test(msg)
        || isBenignOrderModifyError(msg)
      if (benign) {
        await applyCloseUpdate(
          {
            status: 'closed',
            closed_at: new Date().toISOString(),
            close_reason: TRADE_CLOSE_REASON.POSITION_GONE,
            trail_peak_price: null,
          },
          patch => this.supabase.from('trades').update(patch).eq('id', trade.id),
        )
        return null
      }
      console.warn(`[trailingStopMonitor] OrderModify failed trade=${trade.id} ticket=${ticketNum}: ${msg}`)
      await writeExecutionLog(this.supabase, {
        user_id: trade.user_id,
        signal_id: trade.signal_id,
        broker_account_id: trade.broker_account_id,
        action: 'trailing_stop',
        status: 'failed',
        request_payload: { ticket: ticketNum, symbol: trade.symbol, attempted_sl: update.newSl },
        error_message: msg,
      })
      return false
    }
  }

  private async clearTrailWatch(tradeId: string): Promise<void> {
    await this.supabase.from('trades').update({ trail_peak_price: null }).eq('id', tradeId)
  }

  private async getSymbolCache(uuid: string, symbol: string, api: FxsocketBrokerClient): Promise<SymbolCacheEntry | null> {
    const key = `${uuid}:${symbol.toUpperCase()}`
    const cached = this.symbolCache.get(key)
    if (cached && Date.now() - cached.loadedAt < SYMBOL_CACHE_TTL_MS) return cached
    try {
      const p: SymbolParams = await api.symbolParams(uuid, symbol)
      const n = normalizeSymbolParams(p)
      const entry: SymbolCacheEntry = {
        digits: n.digits ?? 5,
        point: n.point ?? 0.00001,
        contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
        loadedAt: Date.now(),
      }
      this.symbolCache.set(key, entry)
      return entry
    } catch {
      return null
    }
  }
}
