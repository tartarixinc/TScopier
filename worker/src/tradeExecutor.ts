import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import {
  getMetatraderApi,
  MetatraderApiClient,
  MtOperation,
  OrderSendArgs,
  SymbolParams,
} from './metatraderapi'
import {
  planManualOrders,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
} from './manualPlanner'

/**
 * Direct trade-execution path. Listens to `signals` Realtime, fans out to every
 * active broker for the signal's owner, and calls MetatraderAPI directly. The
 * old `management_jobs` queue + execute-trade Edge round-trip is bypassed so a
 * parsed signal goes Telegram -> parse-signal -> OrderSend with one HTTPS hop.
 */

const PARSED_STATUSES = new Set(['parsed'])

type ParsedSignal = {
  action: string
  symbol: string | null
  entry_price: number | null
  entry_zone_low: number | null
  entry_zone_high: number | null
  sl: number | null
  tp: number[] | null
  lot_size: number | null
  open_tp?: boolean
  partial_close_fraction?: number | null
  raw_instruction?: string
}

interface SignalRow {
  id: string
  user_id: string
  channel_id: string | null
  parsed_data: ParsedSignal | null
  status: string
  parent_signal_id: string | null
  is_modification: boolean
}

interface BrokerRow {
  id: string
  user_id: string
  is_active: boolean
  platform: string
  metaapi_account_id: string | null
  account_login: string | null
  broker_server: string | null
  copier_mode: 'ai' | 'manual' | null
  signal_channel_ids: string[] | null
  enforce_signal_channel_filter: boolean | null
  ai_settings: Record<string, unknown> | null
  manual_settings: Record<string, unknown> | null
  default_lot_size: number | null
  last_balance: number | null
  last_equity: number | null
  last_currency: string | null
}

interface SymbolCacheEntry {
  digits: number
  point: number
  minLot: number
  maxLot: number
  lotStep: number
  loadedAt: number
}

const SYMBOL_CACHE_TTL_MS = 10 * 60_000

function isMtUuid(s: string | null | undefined): boolean {
  if (!s) return false
  const v = s.trim()
  if (!v || v.includes('|')) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

function applySymbolMapping(raw: string, broker: BrokerRow): string {
  const m = (broker.manual_settings ?? {}) as {
    symbol_mapping?: Record<string, string>
    symbol_prefix?: string
    symbol_suffix?: string
    symbol_to_trade?: string | null
  }
  const upper = raw.toUpperCase()
  const mapped = (m.symbol_mapping?.[upper] ?? upper).toUpperCase()
  const prefix = (m.symbol_prefix ?? '').toUpperCase()
  const suffix = (m.symbol_suffix ?? '').toUpperCase()
  if (m.symbol_to_trade && m.symbol_to_trade.trim()) return m.symbol_to_trade.trim().toUpperCase()
  return `${prefix}${mapped}${suffix}`
}

function isExcluded(symbol: string, broker: BrokerRow): boolean {
  const m = (broker.manual_settings ?? {}) as { symbols_exclude?: string[] }
  const list = (m.symbols_exclude ?? []).map(s => String(s).toUpperCase())
  return list.includes(symbol.toUpperCase())
}

function operationFor(action: string, signal: ParsedSignal): MtOperation | null {
  const a = action.toLowerCase()
  const hasEntry = signal.entry_price != null
  if (a === 'buy') return hasEntry ? 'BuyLimit' : 'Buy'
  if (a === 'sell') return hasEntry ? 'SellLimit' : 'Sell'
  return null
}

function isManagementAction(action: string): boolean {
  const a = action.toLowerCase()
  return a === 'close' || a === 'breakeven' || a === 'partial_profit' || a === 'partial_breakeven' || a === 'modify'
}

function computeLot(broker: BrokerRow, signal: ParsedSignal): number {
  const mode = broker.copier_mode ?? 'ai'
  if (mode === 'manual') {
    const m = (broker.manual_settings ?? {}) as {
      risk_mode?: 'fixed_lot' | 'dynamic_balance_percent'
      fixed_lot?: number
      dynamic_balance_percent?: number
    }
    if (m.risk_mode === 'dynamic_balance_percent') {
      const pct = Number(m.dynamic_balance_percent ?? 1)
      const bal = Number(broker.last_balance ?? 0)
      if (bal > 0 && pct > 0) {
        // Conservative: 0.01 lot per 1% of balance per $1000 — caller can refine via SymbolParams.
        return Math.max(0.01, +(bal * (pct / 100) / 1000).toFixed(2))
      }
    }
    if (typeof signal.lot_size === 'number' && signal.lot_size > 0) return signal.lot_size
    return Math.max(0.01, Number(m.fixed_lot ?? broker.default_lot_size ?? 0.01))
  }

  // AI mode
  const ai = (broker.ai_settings ?? {}) as {
    risk_percent_per_trade?: number
    min_lot?: number
    max_lot?: number
    reference_equity?: number
    fallback_lot?: number | null
  }
  const ref = Number(ai.reference_equity ?? 1000)
  const bal = Number(broker.last_balance ?? broker.last_equity ?? ref)
  const base = Number(ai.fallback_lot ?? broker.default_lot_size ?? 0.01)
  const scaled = ref > 0 ? base * (bal / ref) : base
  const min = Number(ai.min_lot ?? 0.01)
  const max = Number(ai.max_lot ?? 100)
  const final = Math.max(min, Math.min(max, scaled))
  return +final.toFixed(2)
}

function roundLot(volume: number, params: SymbolCacheEntry | null): number {
  if (!params) return Math.max(0.01, +volume.toFixed(2))
  const step = params.lotStep || 0.01
  const min = params.minLot || step
  const max = params.maxLot || 100
  const rounded = Math.max(min, Math.min(max, Math.round(volume / step) * step))
  return +rounded.toFixed(2)
}

function channelMatches(broker: BrokerRow, channelId: string | null): boolean {
  const enforce = broker.enforce_signal_channel_filter === true
  if (!enforce) return true
  const ids = broker.signal_channel_ids ?? []
  if (!ids.length) return true
  if (!channelId) return false
  return ids.includes(channelId)
}

export class TradeExecutor {
  private timer: NodeJS.Timeout | null = null
  private signalsChannel: RealtimeChannel | null = null
  private brokersChannel: RealtimeChannel | null = null
  private channelsChannel: RealtimeChannel | null = null
  private brokersByUser = new Map<string, BrokerRow[]>()
  private brokersById = new Map<string, BrokerRow>()
  private inflight = new Set<string>()
  private symbolCache = new Map<string, SymbolCacheEntry>()
  /** Cached channel rows keyed by `telegram_channels.id` — refreshed on demand. */
  private channelKeywordsCache = new Map<string, { keywords: ChannelKeywords | null; loadedAt: number }>()
  private api: MetatraderApiClient | null

  constructor(private readonly supabase: SupabaseClient) {
    this.api = getMetatraderApi()
    if (!this.api) {
      console.warn('[tradeExecutor] METATRADERAPI_KEY missing — trade execution disabled.')
    }
  }

  async start() {
    await this.loadBrokers()
    this.subscribeSignals()
    this.subscribeBrokers()
    this.subscribeChannelKeywords()
    // Periodic safety sweep: catch any 'parsed' signals we may have missed
    // (Realtime drops, restarts). Cheap query, runs every 15s.
    this.timer = setInterval(() => {
      this.sweep().catch(err => console.error('[tradeExecutor] sweep failed:', err))
    }, 15_000)
    this.timer.unref?.()
    console.log('[tradeExecutor] started')
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.signalsChannel) { void this.supabase.removeChannel(this.signalsChannel); this.signalsChannel = null }
    if (this.brokersChannel) { void this.supabase.removeChannel(this.brokersChannel); this.brokersChannel = null }
    if (this.channelsChannel) { void this.supabase.removeChannel(this.channelsChannel); this.channelsChannel = null }
  }

  // ── caches ────────────────────────────────────────────────────────────

  private async loadBrokers() {
    const { data, error } = await this.supabase
      .from('broker_accounts')
      .select('*')
      .eq('is_active', true)
    if (error) {
      console.error('[tradeExecutor] loadBrokers failed:', error.message)
      return
    }
    this.brokersByUser.clear()
    this.brokersById.clear()
    for (const row of (data ?? []) as BrokerRow[]) {
      this.brokersById.set(row.id, row)
      const arr = this.brokersByUser.get(row.user_id) ?? []
      arr.push(row)
      this.brokersByUser.set(row.user_id, arr)
    }
    console.log(`[tradeExecutor] cached ${this.brokersById.size} broker accounts across ${this.brokersByUser.size} users`)
  }

  private upsertBrokerCache(row: BrokerRow) {
    const previous = this.brokersById.get(row.id)
    this.brokersById.set(row.id, row)
    const userId = row.user_id
    const list = (this.brokersByUser.get(userId) ?? []).filter(b => b.id !== row.id)
    if (row.is_active) list.push(row)
    this.brokersByUser.set(userId, list)
    if (previous && previous.user_id !== userId) {
      const prev = (this.brokersByUser.get(previous.user_id) ?? []).filter(b => b.id !== row.id)
      this.brokersByUser.set(previous.user_id, prev)
    }
  }

  private removeBrokerCache(id: string) {
    const row = this.brokersById.get(id)
    if (!row) return
    this.brokersById.delete(id)
    const list = (this.brokersByUser.get(row.user_id) ?? []).filter(b => b.id !== id)
    this.brokersByUser.set(row.user_id, list)
  }

  // ── realtime ──────────────────────────────────────────────────────────

  private subscribeSignals() {
    if (this.signalsChannel) return
    this.signalsChannel = this.supabase
      .channel('trade_executor_signals')
      .on(
        'postgres_changes' as never,
        { event: 'UPDATE', schema: 'public', table: 'signals' } as never,
        (payload: { new?: Record<string, unknown> }) => {
          const row = payload.new as SignalRow | undefined
          if (!row) return
          if (!PARSED_STATUSES.has(row.status)) return
          this.handleSignal(row).catch(err =>
            console.error(`[tradeExecutor] handleSignal failed for ${row.id}:`, err),
          )
        },
      )
      .subscribe()
  }

  private subscribeBrokers() {
    if (this.brokersChannel) return
    this.brokersChannel = this.supabase
      .channel('trade_executor_brokers')
      .on(
        'postgres_changes' as never,
        { event: '*', schema: 'public', table: 'broker_accounts' } as never,
        (payload: { eventType?: string; new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const evt = payload.eventType
          if (evt === 'DELETE') {
            const id = (payload.old?.id ?? '') as string
            if (id) this.removeBrokerCache(id)
            return
          }
          const row = payload.new as BrokerRow | undefined
          if (!row) return
          if (row.is_active === false) this.removeBrokerCache(row.id)
          else this.upsertBrokerCache(row)
        },
      )
      .subscribe()
  }

  private subscribeChannelKeywords() {
    if (this.channelsChannel) return
    this.channelsChannel = this.supabase
      .channel('trade_executor_channels')
      .on(
        'postgres_changes' as never,
        { event: 'UPDATE', schema: 'public', table: 'telegram_channels' } as never,
        (payload: { new?: Record<string, unknown> }) => {
          const row = payload.new as { id?: string; channel_keywords?: ChannelKeywords | null } | undefined
          if (!row?.id) return
          // Refresh cache eagerly so the next signal picks up edits made in Copier Engine.
          this.channelKeywordsCache.set(row.id, { keywords: row.channel_keywords ?? null, loadedAt: Date.now() })
        },
      )
      .subscribe()
  }

  private async sweep() {
    const since = new Date(Date.now() - 5 * 60_000).toISOString()
    const { data } = await this.supabase
      .from('signals')
      .select('id,user_id,channel_id,parsed_data,status,parent_signal_id,is_modification')
      .eq('status', 'parsed')
      .gte('created_at', since)
      .limit(50)
    for (const row of (data ?? []) as SignalRow[]) {
      if (this.inflight.has(row.id)) continue
      // Skip if a trade for this signal already exists.
      const { count } = await this.supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', row.id)
      if ((count ?? 0) > 0) continue
      await this.handleSignal(row)
    }
  }

  // ── execution ─────────────────────────────────────────────────────────

  private async handleSignal(row: SignalRow) {
    if (!this.api) return
    if (this.inflight.has(row.id)) return
    this.inflight.add(row.id)
    try {
      const parsed = row.parsed_data
      if (!parsed || !parsed.action) return
      const action = String(parsed.action).toLowerCase()
      if (action === 'ignore') return

      const brokers = (this.brokersByUser.get(row.user_id) ?? []).filter(b =>
        b.is_active && isMtUuid(b.metaapi_account_id) && channelMatches(b, row.channel_id),
      )
      if (!brokers.length) return

      // Pre-fetch channel keywords once per signal so manual-mode brokers can
      // honour delay_msec / prefer_entry / *_in_pips / ignore_keyword.
      const channelKeywords = await this.getChannelKeywords(row.channel_id)
      const rawText = String(parsed.raw_instruction ?? '').toLowerCase()
      const ignoreKw = channelKeywords?.additional?.ignore_keyword?.trim().toLowerCase()
      const skipKw = channelKeywords?.additional?.skip_keyword?.trim().toLowerCase()
      if ((ignoreKw && rawText.includes(ignoreKw)) || (skipKw && rawText.includes(skipKw))) {
        // Channel-level ignore — parse-signal usually already short-circuits this,
        // but we double-check here so a stale parse can't slip through.
        return
      }

      if (isManagementAction(action)) {
        await this.applyManagement(row, parsed, brokers)
        return
      }

      const op = operationFor(action, parsed)
      if (!op || !parsed.symbol) return

      await Promise.allSettled(brokers.map(b => this.sendOrder(row, parsed, op, b, channelKeywords)))
    } finally {
      this.inflight.delete(row.id)
    }
  }

  private async getChannelKeywords(channelId: string | null): Promise<ChannelKeywords | null> {
    if (!channelId) return null
    const cached = this.channelKeywordsCache.get(channelId)
    if (cached && Date.now() - cached.loadedAt < 5 * 60_000) return cached.keywords
    try {
      const { data } = await this.supabase
        .from('telegram_channels')
        .select('channel_keywords')
        .eq('id', channelId)
        .maybeSingle()
      const keywords = (data as { channel_keywords?: ChannelKeywords | null } | null)?.channel_keywords ?? null
      this.channelKeywordsCache.set(channelId, { keywords, loadedAt: Date.now() })
      return keywords
    } catch {
      this.channelKeywordsCache.set(channelId, { keywords: null, loadedAt: Date.now() })
      return null
    }
  }

  private async hasOpenTradeForSymbol(brokerId: string, symbol: string): Promise<boolean> {
    try {
      const { count } = await this.supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('broker_account_id', brokerId)
        .eq('symbol', symbol)
        .eq('status', 'open')
      return (count ?? 0) > 0
    } catch {
      return false
    }
  }

  private async sendOrder(
    signal: SignalRow,
    parsed: ParsedSignal,
    op: MtOperation,
    broker: BrokerRow,
    channelKeywords: ChannelKeywords | null,
  ): Promise<void> {
    if (!this.api) return
    const uuid = broker.metaapi_account_id!
    const symbol = applySymbolMapping(parsed.symbol!, broker)
    if (isExcluded(symbol, broker)) return

    const params = await this.getSymbolParams(uuid, symbol).catch(() => null)
    const baseLot = roundLot(computeLot(broker, parsed), params)

    const isManual = (broker.copier_mode ?? 'ai') === 'manual'
    const manual = (broker.manual_settings ?? {}) as ManualSettings

    // Stop here when the user opted out of stacking trades on the same symbol.
    if (isManual && manual.add_new_trades_to_existing === false) {
      const already = await this.hasOpenTradeForSymbol(broker.id, symbol)
      if (already) {
        await this.logSendSkipped(signal, broker, 'add_new_trades_to_existing=false', { symbol })
        return
      }
    }

    // Build the order list. In AI mode we keep the original single-order shape;
    // manual mode delegates to the planner so filters / multi-TP / pip-derived
    // SL & TP / pending expiry / reverse all apply consistently.
    let plan: { orders: OrderSendArgs[]; skip_reason?: string; delay_ms: number }
    if (isManual) {
      const plannerParsed: PlannerParsedSignal = {
        action: parsed.action,
        symbol: parsed.symbol,
        entry_price: parsed.entry_price,
        entry_zone_low: parsed.entry_zone_low,
        entry_zone_high: parsed.entry_zone_high,
        sl: parsed.sl,
        tp: parsed.tp,
        lot_size: parsed.lot_size,
        open_tp: parsed.open_tp,
        partial_close_fraction: parsed.partial_close_fraction,
        raw_instruction: parsed.raw_instruction,
      }
      plan = planManualOrders({
        parsed: plannerParsed,
        resolvedSymbol: symbol,
        baseOperation: op,
        manual,
        channelKeywords,
        manualLot: baseLot,
        ctx: {
          point: params?.point ?? 0.00001,
          digits: params?.digits ?? 5,
          defaultLot: Number(broker.default_lot_size ?? 0.01),
          lastBalance: broker.last_balance ?? null,
        },
        commentPrefix: `TSCopier:${signal.id.slice(0, 8)}`,
        expertId: 909090,
        slippage: 20,
      })
    } else {
      plan = {
        orders: [{
          symbol,
          operation: op,
          volume: baseLot,
          price: parsed.entry_price ?? 0,
          stoploss: parsed.sl ?? 0,
          takeprofit: parsed.tp?.[0] ?? 0,
          slippage: 20,
          comment: `TSCopier:${signal.id.slice(0, 8)}`,
          expertID: 909090,
        }],
        delay_ms: 0,
      }
    }

    if (plan.orders.length === 0) {
      await this.logSendSkipped(signal, broker, plan.skip_reason ?? 'filtered', { symbol })
      return
    }

    if (plan.delay_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(plan.delay_ms, 30_000)))
    }

    // Round volumes per the live SymbolParams before sending.
    const ordersToSend = plan.orders.map(o => ({ ...o, volume: roundLot(o.volume, params) }))

    await Promise.allSettled(
      ordersToSend.map(async (args, idx) => {
        const t0 = Date.now()
        try {
          const result = await this.api!.orderSend(uuid, args)
          const latencyMs = Date.now() - t0
          console.log(
            `[tradeExecutor] OrderSend ok signal=${signal.id} broker=${broker.id} ticket=${result.ticket} leg=${idx + 1}/${ordersToSend.length} ${latencyMs}ms`,
          )

          await this.supabase.from('trades').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            telegram_channel_id: signal.channel_id,
            broker_account_id: broker.id,
            metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
            symbol: args.symbol,
            direction: args.operation.toLowerCase().includes('sell') ? 'sell' : 'buy',
            entry_price: result.openPrice ?? args.price ?? null,
            sl: result.stopLoss ?? args.stoploss ?? null,
            tp: result.takeProfit ?? args.takeprofit ?? null,
            lot_size: result.lots ?? args.volume,
            status: args.operation.includes('Limit') || args.operation.includes('Stop') ? 'pending' : 'open',
            opened_at: new Date().toISOString(),
          })

          await this.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'order_send',
            status: 'success',
            request_payload: args as unknown as Record<string, unknown>,
            response_payload: { ticket: result.ticket, latency_ms: latencyMs, leg: idx + 1, total: ordersToSend.length },
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(
            `[tradeExecutor] OrderSend failed signal=${signal.id} broker=${broker.id} leg=${idx + 1}/${ordersToSend.length}:`,
            msg,
          )
          await this.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'order_send',
            status: 'failed',
            request_payload: args as unknown as Record<string, unknown>,
            error_message: msg,
          })
        }
      }),
    )
  }

  private async logSendSkipped(
    signal: SignalRow,
    broker: BrokerRow,
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'order_send',
        status: 'skipped',
        request_payload: { skip_reason: reason, ...extra } as unknown as Record<string, unknown>,
      })
    } catch {
      // Logging failure is non-fatal.
    }
  }

  private async applyManagement(signal: SignalRow, parsed: ParsedSignal, brokers: BrokerRow[]): Promise<void> {
    if (!this.api) return
    if (!signal.parent_signal_id) return
    const { data: trades } = await this.supabase
      .from('trades')
      .select('id,broker_account_id,metaapi_order_id,symbol,lot_size,status')
      .eq('signal_id', signal.parent_signal_id)
    const rows = (trades ?? []) as {
      id: string
      broker_account_id: string
      metaapi_order_id: string | null
      symbol: string
      lot_size: number
      status: string
    }[]
    if (!rows.length) return

    const byBroker = new Map(brokers.map(b => [b.id, b]))
    const action = String(parsed.action).toLowerCase()

    await Promise.allSettled(rows.map(async trade => {
      const broker = byBroker.get(trade.broker_account_id)
      if (!broker || !isMtUuid(broker.metaapi_account_id)) return
      const uuid = broker.metaapi_account_id!
      const ticket = Number(trade.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) return

      try {
        if (action === 'close') {
          await this.api!.orderClose(uuid, { ticket })
          await this.supabase.from('trades').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', trade.id)
        } else if (action === 'partial_profit' || action === 'partial_breakeven') {
          const fraction = typeof parsed.partial_close_fraction === 'number' && parsed.partial_close_fraction > 0
            ? Math.min(0.95, parsed.partial_close_fraction)
            : 0.5
          const lots = +(trade.lot_size * fraction).toFixed(2)
          await this.api!.orderClose(uuid, { ticket, lots })
        } else if (action === 'breakeven') {
          const { data: t } = await this.supabase.from('trades').select('entry_price').eq('id', trade.id).maybeSingle()
          const entry = Number((t as { entry_price?: number } | null)?.entry_price ?? 0)
          if (entry > 0) await this.api!.orderModify(uuid, { ticket, stoploss: entry })
        } else if (action === 'modify') {
          await this.api!.orderModify(uuid, {
            ticket,
            stoploss: parsed.sl ?? 0,
            takeprofit: parsed.tp?.[0] ?? 0,
          })
          await this.supabase.from('trades').update({
            sl: parsed.sl ?? null,
            tp: parsed.tp?.[0] ?? null,
          }).eq('id', trade.id)
        }
        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: `mgmt_${action}`,
          status: 'success',
          request_payload: { ticket, action },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: `mgmt_${action}`,
          status: 'failed',
          request_payload: { ticket, action },
          error_message: msg,
        })
      }
    }))
  }

  private async getSymbolParams(uuid: string, symbol: string): Promise<SymbolCacheEntry | null> {
    const key = `${uuid}:${symbol.toUpperCase()}`
    const cached = this.symbolCache.get(key)
    if (cached && (Date.now() - cached.loadedAt) < SYMBOL_CACHE_TTL_MS) return cached
    if (!this.api) return null
    try {
      const p: SymbolParams = await this.api.symbolParams(uuid, symbol)
      const entry: SymbolCacheEntry = {
        digits: Number(p.symbol?.digits ?? 5),
        point: Number(p.symbol?.point ?? 0.00001),
        minLot: Number(p.groupParams?.minLot ?? 0.01),
        maxLot: Number(p.groupParams?.maxLot ?? 100),
        lotStep: Number(p.groupParams?.lotStep ?? 0.01),
        loadedAt: Date.now(),
      }
      this.symbolCache.set(key, entry)
      return entry
    } catch {
      return null
    }
  }
}
