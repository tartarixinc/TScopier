import type { SupabaseClient } from '@supabase/supabase-js'
import { computePipQuote } from './pipCalculator'
import {
  computeTrailingStopUpdate,
  normalizeTrailingConfig,
  type TrailingStopConfig,
} from './trailingStop'
import {
  getMetatraderApi,
  MetatraderApiClient,
  normalizeSymbolParams,
  type SymbolParams,
} from './metatraderapi'

interface TrailTradeRow {
  id: string
  user_id: string
  signal_id: string | null
  broker_account_id: string | null
  metaapi_order_id: string | null
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

interface BrokerRow {
  id: string
  metaapi_account_id: string
}

const TICK_INTERVAL_MS = 1_500
const SYMBOL_CACHE_TTL_MS = 5 * 60_000

type SymbolCacheEntry = {
  digits: number
  point: number
  contractSize: number | null
  loadedAt: number
}

export class TrailingStopMonitor {
  private timer: NodeJS.Timeout | null = null
  private api: MetatraderApiClient | null
  private ticking = false
  private firstTickLogged = false
  private quietTicks = 0
  private symbolCache = new Map<string, SymbolCacheEntry>()

  constructor(private readonly supabase: SupabaseClient) {
    this.api = getMetatraderApi()
  }

  start() {
    if (this.timer) return
    if (!this.api) {
      console.warn('[trailingStopMonitor] METATRADERAPI_KEY missing — trailing stop monitor disabled')
      return
    }
    this.timer = setInterval(() => {
      if (this.ticking) return
      this.ticking = true
      this.tick()
        .catch(err => {
          console.error('[trailingStopMonitor] tick error:', err instanceof Error ? err.message : String(err))
        })
        .finally(() => { this.ticking = false })
    }, TICK_INTERVAL_MS)
    console.log(`[trailingStopMonitor] started (interval=${TICK_INTERVAL_MS}ms)`)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    if (!this.api) return

    const { data, error } = await this.supabase
      .from('trades')
      .select(
        'id,user_id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,entry_price,sl,tp,'
        + 'trail_peak_price,trail_last_sl,trail_start_pips,trail_step_pips,trail_distance_pips',
      )
      .eq('status', 'open')
      .not('trail_peak_price', 'is', null)
      .limit(500)
    if (error) {
      console.error('[trailingStopMonitor] select failed:', error.message)
      return
    }
    const rows = (data ?? []) as TrailTradeRow[]
    if (!this.firstTickLogged) {
      this.firstTickLogged = true
      console.log(`[trailingStopMonitor] first tick ok trail_rows=${rows.length}`)
    }
    if (!rows.length) return

    const brokerIds = [...new Set(rows.map(r => r.broker_account_id).filter(Boolean))] as string[]
    const { data: brokers, error: brokerErr } = await this.supabase
      .from('broker_accounts')
      .select('id,metaapi_account_id')
      .in('id', brokerIds)
    if (brokerErr) {
      console.error('[trailingStopMonitor] broker lookup failed:', brokerErr.message)
      return
    }
    const brokerById = new Map((brokers ?? []).map(b => [b.id, b as BrokerRow]))

    const groups = new Map<string, TrailTradeRow[]>()
    for (const row of rows) {
      const b = brokerById.get(row.broker_account_id ?? '')
      if (!b?.metaapi_account_id) continue
      const key = `${b.metaapi_account_id}:${row.symbol.toUpperCase()}`
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
    }

    let modifiedTotal = 0
    let modifyErrTotal = 0
    for (const [key, group] of groups) {
      const uuid = key.split(':')[0]!
      const symbol = group[0]?.symbol ?? ''
      let bid = NaN
      let ask = NaN
      try {
        const q = await this.api.quote(uuid, symbol)
        bid = q.bid
        ask = q.ask
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[trailingStopMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`)
        continue
      }

      for (const trade of group) {
        const ok = await this.maybeTrailTrade(trade, uuid, bid, ask)
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
    bid: number,
    ask: number,
  ): Promise<boolean | null> {
    if (!this.api) return null
    const ticketNum = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
      await this.clearTrailWatch(trade.id)
      return null
    }

    const entry = Number(trade.entry_price)
    const peak = Number(trade.trail_peak_price)
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(peak) || peak <= 0) {
      return null
    }

    const symEntry = await this.getSymbolCache(uuid, trade.symbol)
    if (!symEntry) return null

    const pipQuote = computePipQuote(trade.symbol, {
      point: symEntry.point,
      digits: symEntry.digits,
      contractSize: symEntry.contractSize,
    })
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
      pipPrice: pipQuote.pipPrice,
      digits: symEntry.digits,
      config,
    })
    if (!update) return null

    const tpSanitize = trade.tp != null && Number.isFinite(Number(trade.tp)) && Number(trade.tp) > 0
      ? Number(trade.tp)
      : 0

    try {
      await this.api.orderModify(uuid, {
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
      await this.supabase.from('trade_execution_logs').insert({
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
      const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg)
      if (benign) {
        await this.supabase
          .from('trades')
          .update({ status: 'closed', closed_at: new Date().toISOString(), trail_peak_price: null })
          .eq('id', trade.id)
        return null
      }
      console.warn(`[trailingStopMonitor] OrderModify failed trade=${trade.id} ticket=${ticketNum}: ${msg}`)
      await this.supabase.from('trade_execution_logs').insert({
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

  private async getSymbolCache(uuid: string, symbol: string): Promise<SymbolCacheEntry | null> {
    const key = `${uuid}:${symbol.toUpperCase()}`
    const cached = this.symbolCache.get(key)
    if (cached && Date.now() - cached.loadedAt < SYMBOL_CACHE_TTL_MS) return cached
    if (!this.api) return null
    try {
      const p: SymbolParams = await this.api.symbolParams(uuid, symbol)
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
