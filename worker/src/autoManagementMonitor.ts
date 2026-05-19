import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeBreakevenStopLoss,
  isAutoBeTriggerMet,
  isSlAtOrBeyondBreakeven,
  type AutoBeMode,
  type AutoBeType,
} from './autoManagement'
import { pipCalculator, pipValueForLots } from './pipCalculator'
import { signalPipPrice } from './signalPip'
import {
  hasMetatraderApiConfigured,
  normalizeSymbolParams,
  type MetatraderApiClient,
  type SymbolParams,
} from './metatraderapi'
import { apiForMetaapiAccount, loadPlatformByMetaapiId, type PlatformByMetaapiId } from './mtApiByAccount'

interface AutoBeTradeRow {
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
  lot_size: number | null
  auto_be_mode: string
  auto_be_trigger_value: number | null
  auto_be_tp_index: number | null
  auto_be_type: string | null
  auto_be_offset_pips: number | null
  auto_be_risk_sl: number | null
}

interface PartialLegRow {
  trade_id: string
  tp_idx: number
  trigger_price: number
  status: string
}

interface BrokerRow {
  id: string
  metaapi_account_id: string
  platform: string
  manual_settings: Record<string, unknown> | null
}

const TICK_INTERVAL_MS = 1_500
const SYMBOL_CACHE_TTL_MS = 5 * 60_000

type SymbolCacheEntry = {
  digits: number
  point: number
  contractSize: number | null
  loadedAt: number
}

export class AutoManagementMonitor {
  private timer: NodeJS.Timeout | null = null
  private platformByUuid: PlatformByMetaapiId = new Map()
  private ticking = false
  private firstTickLogged = false
  private quietTicks = 0
  private symbolCache = new Map<string, SymbolCacheEntry>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.timer) return
    if (!hasMetatraderApiConfigured()) {
      console.warn('[autoManagementMonitor] MT4API_BASIC_USER/PASSWORD missing — auto-management monitor disabled')
      return
    }
    this.timer = setInterval(() => {
      if (this.ticking) return
      this.ticking = true
      this.tick()
        .catch(err => {
          console.error('[autoManagementMonitor] tick error:', err instanceof Error ? err.message : String(err))
        })
        .finally(() => { this.ticking = false })
    }, TICK_INTERVAL_MS)
    console.log(`[autoManagementMonitor] started (interval=${TICK_INTERVAL_MS}ms)`)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    if (!hasMetatraderApiConfigured()) return

    const { data, error } = await this.supabase
      .from('trades')
      .select(
        'id,user_id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,entry_price,sl,tp,lot_size,'
        + 'auto_be_mode,auto_be_trigger_value,auto_be_tp_index,auto_be_type,auto_be_offset_pips,auto_be_risk_sl',
      )
      .eq('status', 'open')
      .not('auto_be_mode', 'is', null)
      .is('auto_be_applied_at', null)
      .limit(500)
    if (error) {
      console.error('[autoManagementMonitor] select failed:', error.message)
      return
    }
    const rows = (data ?? []) as unknown as AutoBeTradeRow[]
    if (!this.firstTickLogged) {
      this.firstTickLogged = true
      console.log(`[autoManagementMonitor] first tick ok auto_be_rows=${rows.length}`)
    }
    if (!rows.length) return

    const tradeIds = rows.map(r => r.id)
    const partialByTrade = await this.loadPartialLegs(tradeIds)

    const brokerIds = [...new Set(rows.map(r => r.broker_account_id).filter(Boolean))] as string[]
    const { data: brokers, error: brokerErr } = await this.supabase
      .from('broker_accounts')
      .select('id,metaapi_account_id,platform,manual_settings')
      .in('id', brokerIds)
    if (brokerErr) {
      console.error('[autoManagementMonitor] broker lookup failed:', brokerErr.message)
      return
    }
    const brokerById = new Map((brokers ?? []).map(b => [b.id, b as BrokerRow]))
    this.platformByUuid = await loadPlatformByMetaapiId(
      this.supabase,
      (brokers ?? []).map(b => String((b as BrokerRow).metaapi_account_id ?? '')),
    )

    const groups = new Map<string, AutoBeTradeRow[]>()
    for (const row of rows) {
      const b = brokerById.get(row.broker_account_id ?? '')
      if (!b?.metaapi_account_id) continue
      const key = `${b.metaapi_account_id}:${row.symbol.toUpperCase()}`
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
    }

    let appliedTotal = 0
    let applyErrTotal = 0
    for (const [key, group] of groups) {
      const uuid = key.split(':')[0]!
      const symbol = group[0]?.symbol ?? ''
      let bid = NaN
      let ask = NaN
      const api = apiForMetaapiAccount(this.platformByUuid, uuid)
      if (!api) continue
      try {
        const q = await api.quote(uuid, symbol)
        bid = q.bid
        ask = q.ask
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[autoManagementMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`)
        continue
      }

      for (const trade of group) {
        const partials = partialByTrade.get(trade.id) ?? []
        const broker = brokerById.get(trade.broker_account_id ?? '')
        const manual = (broker?.manual_settings ?? {}) as { half_close_percent?: number }
        const halfClosePct = Math.min(
          99,
          Math.max(1, Math.floor(Number(manual.half_close_percent ?? 50) || 50)),
        )
        const ok = await this.maybeApplyBreakeven(trade, uuid, api, bid, ask, partials, halfClosePct)
        if (ok === true) appliedTotal++
        if (ok === false) applyErrTotal++
      }
    }

    if (appliedTotal > 0 || applyErrTotal > 0) {
      this.quietTicks = 0
      console.log(
        `[autoManagementMonitor] tick rows=${rows.length} groups=${groups.size} applied=${appliedTotal} errors=${applyErrTotal}`,
      )
    } else if (++this.quietTicks >= 20) {
      this.quietTicks = 0
      console.log(`[autoManagementMonitor] heartbeat rows=${rows.length} groups=${groups.size} (no BE updates this cycle)`)
    }
  }

  private async loadPartialLegs(tradeIds: string[]): Promise<Map<string, PartialLegRow[]>> {
    const out = new Map<string, PartialLegRow[]>()
    if (!tradeIds.length) return out
    const { data, error } = await this.supabase
      .from('partial_tp_legs')
      .select('trade_id,tp_idx,trigger_price,status')
      .in('trade_id', tradeIds)
    if (error) {
      console.warn(`[autoManagementMonitor] partial_tp_legs select failed: ${error.message}`)
      return out
    }
    for (const row of (data ?? []) as PartialLegRow[]) {
      const list = out.get(row.trade_id) ?? []
      list.push(row)
      out.set(row.trade_id, list)
    }
    return out
  }

  private async maybeApplyBreakeven(
    trade: AutoBeTradeRow,
    uuid: string,
    api: MetatraderApiClient,
    bid: number,
    ask: number,
    partials: PartialLegRow[],
    halfClosePercent: number,
  ): Promise<boolean | null> {
    const ticketNum = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
      await this.markApplied(trade.id, { clearWatch: true })
      return null
    }

    const entry = Number(trade.entry_price)
    if (!Number.isFinite(entry) || entry <= 0) return null

    const symEntry = await this.getSymbolCache(uuid, trade.symbol)
    if (!symEntry) return null

    const pipQuote = pipCalculator(
      trade.symbol,
      symEntry.point,
      symEntry.digits,
      symEntry.contractSize,
    )
    const signalPip = signalPipPrice(trade.symbol)
    const lots = Number(trade.lot_size ?? 0)
    const pipValuePerLot = pipValueForLots(pipQuote, lots > 0 ? lots : 0.01)

    const mode = String(trade.auto_be_mode).toLowerCase() as AutoBeMode
    const triggerValue = Number(trade.auto_be_trigger_value ?? 0)
    const tpIndex = Number(trade.auto_be_tp_index ?? 1)
    const offsetPips = Number(trade.auto_be_offset_pips ?? 0)
    const beType = String(trade.auto_be_type ?? 'sl_only').toLowerCase() as AutoBeType
    const isBuy = String(trade.direction).toLowerCase() === 'buy'

    const partialTpFiredIndices = partials
      .filter(p => p.status === 'fired')
      .map(p => p.tp_idx)
    const partialTpTriggers = partials
      .filter(p => p.status === 'pending' || p.status === 'fired')
      .map(p => ({ tpIdx: p.tp_idx, triggerPrice: Number(p.trigger_price) }))

    const brokerTp = trade.tp != null && Number.isFinite(Number(trade.tp)) && Number(trade.tp) > 0
      ? Number(trade.tp)
      : null

    const riskSl = trade.auto_be_risk_sl != null && Number.isFinite(Number(trade.auto_be_risk_sl))
      ? Number(trade.auto_be_risk_sl)
      : (trade.sl != null && Number.isFinite(Number(trade.sl)) ? Number(trade.sl) : null)

    const beSl = computeBreakevenStopLoss(isBuy, entry, offsetPips, signalPip, symEntry.digits)
    const currentSl = trade.sl != null && Number.isFinite(Number(trade.sl)) ? Number(trade.sl) : null

    if (isSlAtOrBeyondBreakeven(isBuy, currentSl, beSl, signalPip)) {
      await this.markApplied(trade.id, { sl: currentSl ?? beSl })
      return null
    }

    if (!isAutoBeTriggerMet({
      mode,
      triggerValue,
      tpIndex,
      isBuy,
      entryPrice: entry,
      riskSl,
      bid,
      ask,
      pipPrice: signalPip,
      pipValuePerLot,
      partialTpFiredIndices,
      partialTpTriggers,
      brokerTp,
    })) {
      return null
    }

    const tpSanitize = brokerTp ?? 0

    try {
      await api.orderModify(uuid, {
        ticket: ticketNum,
        stoploss: beSl,
        takeprofit: tpSanitize,
      })

      let remainingLots = lots
      if (beType === 'sl_and_close_half' && lots > 0.0001) {
        const closeLots = +(lots * (halfClosePercent / 100)).toFixed(2)
        if (closeLots >= 0.01) {
          try {
            await api.orderClose(uuid, { ticket: ticketNum, lots: closeLots })
            remainingLots = Math.max(0, +(lots - closeLots).toFixed(2))
          } catch (halfErr) {
            const msg = halfErr instanceof Error ? halfErr.message : String(halfErr)
            console.warn(
              `[autoManagementMonitor] half close failed trade=${trade.id} ticket=${ticketNum}: ${msg}`,
            )
          }
        }
      }

      const patch: Record<string, unknown> = {
        sl: beSl,
        auto_be_applied_at: new Date().toISOString(),
      }
      if (remainingLots < 0.0001) {
        patch.status = 'closed'
        patch.closed_at = new Date().toISOString()
        patch.lot_size = 0
      } else if (remainingLots !== lots) {
        patch.lot_size = remainingLots
      }

      await this.supabase.from('trades').update(patch).eq('id', trade.id).eq('status', 'open')

      await this.supabase.from('trade_execution_logs').insert({
        user_id: trade.user_id,
        signal_id: trade.signal_id,
        broker_account_id: trade.broker_account_id,
        action: 'auto_be',
        status: 'success',
        request_payload: {
          ticket: ticketNum,
          symbol: trade.symbol,
          direction: trade.direction,
          mode,
          trigger_value: triggerValue,
          new_sl: beSl,
          be_type: beType,
          half_close: beType === 'sl_and_close_half',
        } as unknown as Record<string, unknown>,
      })

      console.log(
        `[autoManagementMonitor] applied trade=${trade.id} symbol=${trade.symbol} mode=${mode} sl→${beSl}`,
      )
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg)
      if (benign) {
        await this.supabase
          .from('trades')
          .update({
            status: 'closed',
            closed_at: new Date().toISOString(),
            auto_be_applied_at: new Date().toISOString(),
          })
          .eq('id', trade.id)
        return null
      }
      console.warn(`[autoManagementMonitor] apply failed trade=${trade.id} ticket=${ticketNum}: ${msg}`)
      await this.supabase.from('trade_execution_logs').insert({
        user_id: trade.user_id,
        signal_id: trade.signal_id,
        broker_account_id: trade.broker_account_id,
        action: 'auto_be',
        status: 'failed',
        request_payload: { ticket: ticketNum, symbol: trade.symbol, attempted_sl: beSl, mode },
        error_message: msg,
      })
      return false
    }
  }

  private async markApplied(
    tradeId: string,
    opts: { sl?: number | null; clearWatch?: boolean },
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      auto_be_applied_at: new Date().toISOString(),
    }
    if (opts.sl != null && Number.isFinite(opts.sl)) patch.sl = opts.sl
    if (opts.clearWatch) {
      patch.auto_be_mode = null
    }
    await this.supabase.from('trades').update(patch).eq('id', tradeId)
  }

  private async getSymbolCache(uuid: string, symbol: string): Promise<SymbolCacheEntry | null> {
    const key = `${uuid}:${symbol.toUpperCase()}`
    const cached = this.symbolCache.get(key)
    if (cached && Date.now() - cached.loadedAt < SYMBOL_CACHE_TTL_MS) return cached
    const api = apiForMetaapiAccount(this.platformByUuid, uuid)
    if (!api) return null
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
