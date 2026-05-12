import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import {
  getMetatraderApi,
  MetatraderApiClient,
  MtOperation,
  OrderSendArgs,
  SymbolParams,
} from './metatraderapi'
import {
  computeCwOverrideTp,
  planManualOrders,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerResult,
  type VirtualPendingLeg,
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
  /** Broker-reported min SL/TP distance from market, in MT points (0 = no enforcement). */
  stopsLevel: number
  /**
   * Broker-reported freeze distance, in MT points. Pending orders inside this band
   * cannot be modified or closed; treated as another floor on the "safe" SL/TP
   * distance alongside `stopsLevel`. 0 = no enforcement.
   */
  freezeLevel: number
  loadedAt: number
}

interface SymbolListCacheEntry {
  /** Uppercase set of valid symbol names for fast O(1) lookups. */
  set: Set<string>
  /** Original list of names (case preserved) so we can return the broker's canonical casing. */
  list: string[]
  loadedAt: number
}

const SYMBOL_CACHE_TTL_MS = 10 * 60_000
const SYMBOL_LIST_TTL_MS = 30 * 60_000

function isMtUuid(s: string | null | undefined): boolean {
  if (!s) return false
  const v = s.trim()
  if (!v || v.includes('|')) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

/**
 * Parse the (free-form) "Symbol To Trade" field into a list of allowed symbols.
 * Accepts comma, semicolon, or whitespace separators so users can type
 * `XAUUSD, BTCUSD` or `XAUUSD BTCUSD` interchangeably.
 */
function parseSymbolToTradeList(value: string | null | undefined): string[] {
  if (!value || !value.trim()) return []
  return value
    .split(/[,;\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length > 0)
}

interface SymbolMappingResult {
  /** The exact symbol the worker should send to MetatraderAPI. */
  symbol: string
  /**
   * When non-empty, the signal's symbol must match one of these (case-insensitive)
   * for the trade to be eligible. Empty means "no whitelist filter".
   */
  whitelist: string[]
}

function applySymbolMapping(raw: string, broker: BrokerRow): SymbolMappingResult {
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

  const allowed = parseSymbolToTradeList(m.symbol_to_trade)
  // Single entry → treat as a hard override (force every signal to this instrument).
  // Multiple entries → whitelist mode (only signals matching one of these symbols pass through).
  if (allowed.length === 1) {
    return { symbol: allowed[0], whitelist: [] }
  }

  return {
    symbol: `${prefix}${mapped}${suffix}`,
    whitelist: allowed,
  }
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

/** Buy-side ops want SL below / TP above the reference price; Sell-side is reversed. */
function isBuySideOp(op: string): boolean {
  return op === 'Buy' || op === 'BuyLimit' || op === 'BuyStop' || op === 'BuyStopLimit'
}

/**
 * Push SL/TP outside the broker's minimum stops distance so MT5 can't reject the
 * payload with "Invalid stops in the request". Uses `args.price` (the planner's
 * intended fill/entry, or the executor-resolved anchor for range pendings) as
 * the reference. Honors both `stopsLevel` (the SL/TP minimum) and `freezeLevel`
 * (the in-zone modification ban) — we take the larger of the two so neither
 * server-side check can reject the payload. Returns the (possibly mutated)
 * order plus a human-readable list of adjustments.
 */
function clampOrderStops(
  args: OrderSendArgs,
  params: SymbolCacheEntry | null,
): { args: OrderSendArgs; adjustments: string[] } {
  const adjustments: string[] = []
  if (!params) return { args, adjustments }
  const point = Number(params.point) || 0
  const stopsLevel = Number(params.stopsLevel) || 0
  const freezeLevel = Number(params.freezeLevel) || 0
  if (point <= 0) return { args, adjustments }

  // +2 points of safety so we sit just outside the broker's threshold rather
  // than exactly on it (some brokers reject equal-to-threshold as well).
  const minLevel = Math.max(stopsLevel, freezeLevel)
  const minDist = (minLevel + 2) * point
  const ref = Number(args.price) || 0
  if (ref <= 0 || minDist <= 0) return { args, adjustments }

  const digits = Math.max(0, Math.min(8, Number(params.digits) || 5))
  const round = (v: number): number => Number(v.toFixed(digits))
  const isBuy = isBuySideOp(String(args.operation))

  let sl = Number(args.stoploss) || 0
  let tp = Number(args.takeprofit) || 0
  const original = { sl, tp }

  if (isBuy) {
    if (sl > 0 && ref - sl < minDist) sl = round(ref - minDist)
    if (tp > 0 && tp - ref < minDist) tp = round(ref + minDist)
  } else {
    if (sl > 0 && sl - ref < minDist) sl = round(ref + minDist)
    if (tp > 0 && ref - tp < minDist) tp = round(ref - minDist)
  }

  if (sl !== original.sl) adjustments.push(`sl ${original.sl} → ${sl}`)
  if (tp !== original.tp) adjustments.push(`tp ${original.tp} → ${tp}`)
  if (adjustments.length === 0) return { args, adjustments }
  return { args: { ...args, stoploss: sl, takeprofit: tp }, adjustments }
}

interface Leg {
  args: OrderSendArgs
  idx: number
}

/**
 * Compute the single CWE override TP price for this plan against the resolved
 * anchor. The executor applies this same value to the first N immediate orders
 * AND the first N shallowest virtual pendings (sorted by stepIdx) before
 * sending / persisting. Returns `null` when CWE is off or inputs are missing.
 */
function computeCweTp(
  plan: PlannerResult,
  anchor: number | null,
  params: SymbolCacheEntry | null,
): number | null {
  if (!plan.closeWorseEntries || plan.pip == null || plan.isBuy == null) return null
  if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) return null
  const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
  const point = Number(params?.point) || 0
  const stopsLevel = Number(params?.stopsLevel) || 0
  const freezeLevel = Number(params?.freezeLevel) || 0
  const safe = Math.max(stopsLevel, freezeLevel)
  const minStopDistance = safe > 0 && point > 0 ? (safe + 2) * point : 0
  return computeCwOverrideTp({
    policy: plan.closeWorseEntries,
    anchor,
    isBuy: plan.isBuy,
    pip: plan.pip,
    digits,
    minStopDistance,
  })
}

/**
 * Compute the persisted `trigger_price` for a virtual leg from the live anchor.
 *   buy ladder  : trigger = anchor - stepIdx × stepPriceOffset (averages DOWN)
 *   sell ladder : trigger = anchor + stepIdx × stepPriceOffset (averages UP)
 */
function triggerPriceFor(leg: VirtualPendingLeg, anchor: number, digits: number): number {
  const dir = leg.isBuy ? -1 : 1
  const px = anchor + dir * leg.stepIdx * leg.stepPriceOffset
  const d = Math.max(0, Math.min(8, Math.floor(digits)))
  return Number(px.toFixed(d))
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
  /** Per-broker `/Symbols` cache used to map signal symbols (e.g. BTCUSD) to broker variants (BTCUSDm). */
  private symbolListCache = new Map<string, SymbolListCacheEntry>()
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
    if (String(process.env.WORKER_LEGACY_PENDING_CLEANUP ?? '').toLowerCase() === 'true') {
      this.cleanupLegacyBrokerPendings().catch(err =>
        console.error('[tradeExecutor] legacy pending cleanup failed:', err),
      )
    }
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
    const mapping = applySymbolMapping(parsed.symbol!, broker)

    // Whitelist mode: when the user listed multiple symbols, only let signals
    // matching one of them through. Skip the signal otherwise.
    if (mapping.whitelist.length > 0) {
      const sig = (parsed.symbol ?? '').toUpperCase()
      if (!mapping.whitelist.includes(sig)) {
        await this.logSendSkipped(signal, broker, 'symbol_not_in_whitelist', {
          signal_symbol: parsed.symbol ?? null,
          allowed: mapping.whitelist,
        })
        return
      }
    }

    const requestedSymbol = mapping.symbol
    if (isExcluded(requestedSymbol, broker)) return

    // Resolve to the broker's actual instrument name (e.g. BTCUSD → BTCUSDm).
    // Falls back to the requested symbol when /Symbols is unavailable or has no match.
    const symbol = await this.resolveBrokerSymbol(uuid, requestedSymbol)
    if (symbol.toUpperCase() !== requestedSymbol.toUpperCase()) {
      console.log(`[tradeExecutor] symbol resolved broker=${broker.id} ${requestedSymbol} → ${symbol}`)
    }

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
    let plan: PlannerResult
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
          minLot: params?.minLot ?? 0.01,
          lotStep: params?.lotStep ?? 0.01,
          stopsLevel: params?.stopsLevel ?? 0,
          freezeLevel: params?.freezeLevel ?? 0,
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

    if (plan.fallback_reason) {
      // Non-fatal: the planner had to soften its strategy (e.g. multi → single because
      // the per-leg target was below minLot). Surface the reason in worker logs and
      // also persist it for the trades UI.
      console.warn(
        `[tradeExecutor] plan_fallback signal=${signal.id} broker=${broker.id} symbol=${symbol} reason=${plan.fallback_reason}`,
      )
      try {
        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'plan_fallback',
          status: 'info',
          request_payload: {
            reason: plan.fallback_reason,
            manual_lot: baseLot,
            target_leg: +(baseLot * ((Number(manual.multi_trade_leg_percent ?? 5)) / 100)).toFixed(4),
            min_lot: params?.minLot ?? null,
            lot_step: params?.lotStep ?? null,
            stops_level: params?.stopsLevel ?? null,
            freeze_level: params?.freezeLevel ?? null,
            symbol,
          } as unknown as Record<string, unknown>,
        })
      } catch {
        // Logging failure is non-fatal.
      }
    }

    if (plan.delay_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(plan.delay_ms, 30_000)))
    }

    // Hard cap: planner already respects 500; this is a final guard rail.
    const capped = plan.orders.slice(0, 500)
    if (capped.length < plan.orders.length) {
      console.warn(
        `[tradeExecutor] capped immediate legs ${plan.orders.length} → ${capped.length} signal=${signal.id} broker=${broker.id}`,
      )
    }
    const virtualPendings = (plan.virtualPendings ?? []).slice(0, 500)

    // Build immediate legs with rounded volumes. Immediates already carry the
    // planner's intended entry price (signal entry or zero for true market orders).
    const volumeRounded = capped.map(o => ({ ...o, volume: roundLot(o.volume, params) }))
    let legs: Leg[] = volumeRounded.map((args, idx) => ({ args, idx }))

    // ── Anchor resolution ────────────────────────────────────────────────
    // Priority: parsed signal entry → live /Quote (Ask for buy, Bid for sell).
    // Needed whenever we have virtual pendings to persist (so we can compute
    // trigger prices) OR Close-Worse-Entries is on (so we can compute the
    // single override TP). The Quote is a ~50-150ms GET that we issue BEFORE
    // sending immediates so every leg + every virtual trigger sees the same
    // deterministic reference price.
    const needsAnchor = virtualPendings.length > 0 || !!plan.closeWorseEntries
    let anchor: number | null = plan.anchor?.value ?? null
    let anchorSource: 'signal' | 'quote' | 'unknown' = plan.anchor?.source ?? 'unknown'
    if (needsAnchor && (anchor == null || anchor <= 0) && this.api) {
      try {
        const q = await this.api.quote(uuid, symbol)
        anchor = plan.isBuy === false ? q.bid : q.ask
        anchorSource = 'quote'
        console.log(
          `[tradeExecutor] quote anchor signal=${signal.id} broker=${broker.id} symbol=${symbol} bid=${q.bid} ask=${q.ask} anchor=${anchor}`,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[tradeExecutor] /Quote failed for ${symbol} signal=${signal.id} broker=${broker.id}: ${msg}`,
        )
      }
    }

    // Apply Close-Worse-Entries TP override to the first N immediates + first
    // N shallowest virtual pendings. The single override price is shared.
    const overrideTp = computeCweTp(plan, anchor, params)
    if (overrideTp != null && plan.closeWorseEntries) {
      const nImm = Math.max(0, Math.min(legs.length, plan.closeWorseEntries.immediates))
      for (let i = 0; i < nImm; i++) {
        legs[i] = {
          ...legs[i]!,
          args: {
            ...legs[i]!.args,
            takeprofit: overrideTp,
            comment: `${legs[i]!.args.comment ?? ''}.cw`,
          },
        }
      }
      const nVirt = Math.max(0, Math.min(virtualPendings.length, plan.closeWorseEntries.extraPendings))
      // Virtuals are already ordered by stepIdx ascending (shallowest first).
      for (let i = 0; i < nVirt; i++) {
        virtualPendings[i] = {
          ...virtualPendings[i]!,
          takeprofit: overrideTp,
          comment: `${virtualPendings[i]!.comment}.cw`,
        }
      }
    }

    if (isManual) {
      // One-line plan summary so it's obvious whether Range Trading / CWE are
      // actually firing, and at which anchor. Helps debug "settings not applying".
      const point = Number(params?.point) || 0
      const stopsLevel = Number(params?.stopsLevel) || 0
      const freezeLevel = Number(params?.freezeLevel) || 0
      console.log(
        `[tradeExecutor] manual plan signal=${signal.id} broker=${broker.id} symbol=${symbol}`
        + ` style=${manual.trade_style ?? 'single'} legs=${legs.length + virtualPendings.length}`
        + ` (immediate=${legs.length}, virtual_pending=${virtualPendings.length})`
        + ` rangeOn=${manual.range_trading === true} cwOn=${!!plan.closeWorseEntries}`
        + (overrideTp != null ? ` cwTp=${overrideTp}` : '')
        + ` pip=${plan.pip ?? 'n/a'} anchorSource=${anchorSource} anchor=${anchor ?? 'n/a'}`
        + ` stops_level=${stopsLevel} freeze_level=${freezeLevel} point=${point}`
        + (plan.fallback_reason ? ` fallback=${plan.fallback_reason}` : ''),
      )
    }

    // ── Materialize virtual pendings into range_pending_legs ───────────────
    // Persisted with a computed `trigger_price`; the worker monitor + edge
    // sweep race to fire each one as a MARKET OrderSend when /Quote crosses
    // the trigger. We INSERT in bulk so all rows hit Postgres in one round-trip
    // and the worker monitor can pick them up on its very next tick.
    if (virtualPendings.length > 0) {
      if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) {
        console.warn(
          `[tradeExecutor] dropping ${virtualPendings.length} virtual pendings: no anchor available for signal=${signal.id} broker=${broker.id} symbol=${symbol}`,
        )
      } else {
        const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
        const safe = Math.max(Number(params?.stopsLevel) || 0, Number(params?.freezeLevel) || 0)
        const zoneHi = safe > 0 ? anchor + (safe + 2) * (params?.point ?? 0) : null
        const zoneLo = safe > 0 ? anchor - (safe + 2) * (params?.point ?? 0) : null
        const nowMs = Date.now()
        const insertRows: Record<string, unknown>[] = []
        for (const v of virtualPendings) {
          const triggerPrice = triggerPriceFor(v, anchor, digits)
          // Sanity: the trigger MUST sit outside the broker's stops/freeze zone.
          // The planner auto-expands stepPips for this — but if a downstream
          // freeze widens, drop the leg rather than ship it.
          if (zoneHi != null && zoneLo != null && triggerPrice > zoneLo && triggerPrice < zoneHi) {
            console.warn(
              `[tradeExecutor] dropped virtual pending stepIdx=${v.stepIdx} signal=${signal.id}`
              + ` trigger=${triggerPrice} inside stops_zone=[${zoneLo}, ${zoneHi}]`,
            )
            continue
          }
          const expiresAt = v.expiryHours && v.expiryHours > 0
            ? new Date(nowMs + v.expiryHours * 60 * 60 * 1000).toISOString()
            : null
          insertRows.push({
            signal_id: signal.id,
            user_id: signal.user_id,
            broker_account_id: broker.id,
            metaapi_account_id: uuid,
            symbol,
            step_idx: v.stepIdx,
            is_buy: v.isBuy,
            volume: roundLot(v.volume, params),
            anchor_price: anchor,
            trigger_price: triggerPrice,
            stoploss: v.stoploss,
            takeprofit: v.takeprofit,
            slippage: v.slippage,
            comment: v.comment,
            expert_id: v.expertID ?? null,
            expires_at: expiresAt,
            status: 'pending',
          })
        }
        if (insertRows.length > 0) {
          const { error: insertErr } = await this.supabase
            .from('range_pending_legs')
            .insert(insertRows)
          if (insertErr) {
            console.error(
              `[tradeExecutor] range_pending_legs INSERT failed signal=${signal.id} broker=${broker.id}: ${insertErr.message}`,
            )
            try {
              await this.supabase.from('trade_execution_logs').insert({
                user_id: signal.user_id,
                signal_id: signal.id,
                broker_account_id: broker.id,
                action: 'virtual_pending_failed',
                status: 'failed',
                request_payload: { rows: insertRows.length, anchor, anchorSource } as unknown as Record<string, unknown>,
                error_message: insertErr.message,
              })
            } catch { /* logging is best-effort */ }
          } else {
            console.log(
              `[tradeExecutor] virtual pendings inserted=${insertRows.length} signal=${signal.id} broker=${broker.id} symbol=${symbol} anchor=${anchor} (${anchorSource})`,
            )
            try {
              await this.supabase.from('trade_execution_logs').insert({
                user_id: signal.user_id,
                signal_id: signal.id,
                broker_account_id: broker.id,
                action: 'virtual_pending_inserted',
                status: 'success',
                request_payload: {
                  rows: insertRows.length,
                  anchor,
                  anchorSource,
                  symbol,
                  stepIdxs: insertRows.map(r => r.step_idx),
                  triggers: insertRows.map(r => r.trigger_price),
                } as unknown as Record<string, unknown>,
              })
            } catch { /* logging is best-effort */ }
          }
        }
      }
    }

    if (legs.length === 0) {
      // No immediates to send — the trade is purely virtual pendings (or the
      // planner dropped them). Nothing more to do here.
      return
    }

    const totalCount = legs.length

    const sendLeg = async (leg: Leg): Promise<void> => {
      let args = leg.args
      // Final SL/TP clamp using the actual market/entry price as the reference.
      const clamped = clampOrderStops(args, params)
      if (clamped.adjustments.length > 0) {
        console.warn(
          `[tradeExecutor] stops clamped signal=${signal.id} broker=${broker.id} symbol=${args.symbol} op=${args.operation}: ${clamped.adjustments.join(', ')}`,
        )
      }
      args = clamped.args
      const t0 = Date.now()
      try {
        const result = await this.api!.orderSend(uuid, args)
        const latencyMs = Date.now() - t0
        console.log(
          `[tradeExecutor] OrderSend ok signal=${signal.id} broker=${broker.id} ticket=${result.ticket} leg=${leg.idx + 1}/${totalCount} price=${args.price ?? 0} ${latencyMs}ms`,
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
          response_payload: { ticket: result.ticket, latency_ms: latencyMs, leg: leg.idx + 1, total: totalCount },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(
          `[tradeExecutor] OrderSend failed signal=${signal.id} broker=${broker.id} leg=${leg.idx + 1}/${totalCount} op=${args.operation} price=${args.price ?? 0}:`,
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
    }

    // All immediates fan out in parallel. Virtual pendings are already
    // persisted; the worker monitor + edge sweep will fire them on trigger.
    await Promise.allSettled(legs.map(sendLeg))
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

  /**
   * One-time cleanup of broker-side BuyLimit/SellLimit orders left over from
   * the pre-virtual-pendings era. Filters by our `TSCopier:` comment prefix so
   * we never touch orders placed by the user manually or other systems.
   *
   * Gated by env flag `WORKER_LEGACY_PENDING_CLEANUP=true`. Safe to leave on
   * indefinitely — it becomes a no-op once the legacy pendings are gone.
   */
  private async cleanupLegacyBrokerPendings(): Promise<void> {
    if (!this.api) return
    const brokers = Array.from(this.brokersById.values()).filter(b =>
      b.is_active && isMtUuid(b.metaapi_account_id),
    )
    if (!brokers.length) return
    console.log(`[tradeExecutor] legacy pending cleanup: scanning ${brokers.length} brokers...`)
    let totalClosed = 0
    let totalFailed = 0
    for (const broker of brokers) {
      const uuid = broker.metaapi_account_id!
      let orders: unknown[]
      try {
        orders = await this.api.openedOrders(uuid)
      } catch (err) {
        console.warn(`[tradeExecutor] legacy cleanup /OpenedOrders failed broker=${broker.id}: ${(err as Error).message}`)
        continue
      }
      for (const raw of orders ?? []) {
        if (!raw || typeof raw !== 'object') continue
        const o = raw as Record<string, unknown>
        const operation = String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '')
        const comment = String(o.comment ?? o.Comment ?? '')
        const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
        if (!operation.includes('Limit') && !operation.includes('Stop')) continue
        if (!comment.startsWith('TSCopier:')) continue
        if (!Number.isFinite(ticket) || ticket <= 0) continue
        try {
          await this.api.orderClose(uuid, { ticket })
          totalClosed += 1
          console.log(`[tradeExecutor] legacy cleanup closed ticket=${ticket} broker=${broker.id} op=${operation}`)
        } catch (err) {
          totalFailed += 1
          console.warn(`[tradeExecutor] legacy cleanup close failed ticket=${ticket} broker=${broker.id}: ${(err as Error).message}`)
        }
      }
    }
    console.log(`[tradeExecutor] legacy pending cleanup done: closed=${totalClosed} failed=${totalFailed}`)
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
        stopsLevel: Math.max(0, Number(p.symbol?.stopsLevel ?? 0) || 0),
        freezeLevel: Math.max(0, Number(p.symbol?.freezeLevel ?? 0) || 0),
        loadedAt: Date.now(),
      }
      this.symbolCache.set(key, entry)
      return entry
    } catch {
      return null
    }
  }

  /** Load (and cache) the broker's full symbol list. Returns null if unavailable. */
  private async getSymbolList(uuid: string): Promise<SymbolListCacheEntry | null> {
    const cached = this.symbolListCache.get(uuid)
    if (cached && (Date.now() - cached.loadedAt) < SYMBOL_LIST_TTL_MS) return cached
    if (!this.api) return null
    try {
      const raw = await this.api.symbols(uuid)
      const list: string[] = []
      const set = new Set<string>()
      if (Array.isArray(raw)) {
        for (const item of raw) {
          let name: string | null = null
          if (typeof item === 'string') name = item
          else if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>
            const n = o.symbolName ?? o.SymbolName ?? o.symbol ?? o.Symbol ?? o.name ?? o.Name
            if (typeof n === 'string') name = n
          }
          if (name && name.trim()) {
            list.push(name)
            set.add(name.toUpperCase())
          }
        }
      }
      if (!list.length) return null
      const entry: SymbolListCacheEntry = { set, list, loadedAt: Date.now() }
      this.symbolListCache.set(uuid, entry)
      return entry
    } catch {
      return null
    }
  }

  /**
   * Map a generic symbol (e.g. 'BTCUSD') to the exact instrument name the broker
   * exposes (e.g. 'BTCUSDm', 'BTCUSD.r', 'BTCUSD_i'). Strategy:
   *   1. Honour an explicit manual mapping when one exists for this symbol.
   *   2. Fall back to fuzzy matching against `/Symbols` using common broker suffixes
   *      and prefix/suffix substitution. Picks the shortest match (closest variant).
   */
  private async resolveBrokerSymbol(uuid: string, requested: string): Promise<string> {
    const target = requested.toUpperCase()
    const inventory = await this.getSymbolList(uuid)
    if (!inventory) return requested

    if (inventory.set.has(target)) {
      const exact = inventory.list.find(s => s.toUpperCase() === target)
      return exact ?? requested
    }

    const SUFFIXES = ['', 'M', '.M', 'M.RAW', '.RAW', '.PRO', '.R', '_R', '.I', '_I', '.C', '_C', '.S', '_S', '.X', '_X', '#', '+']
    const PREFIXES = ['', '#', '_']
    const candidates: string[] = []
    for (const p of PREFIXES) for (const s of SUFFIXES) {
      const c = `${p}${target}${s}`
      if (c !== target && inventory.set.has(c)) candidates.push(c)
    }
    if (candidates.length) {
      candidates.sort((a, b) => a.length - b.length)
      const winner = candidates[0]
      const exact = inventory.list.find(s => s.toUpperCase() === winner)
      return exact ?? winner
    }

    // Last resort: any instrument that CONTAINS the requested ticker (e.g. "XAUUSDpro").
    const contains = inventory.list.filter(s => s.toUpperCase().includes(target))
    if (contains.length === 1) return contains[0]
    if (contains.length > 1) {
      contains.sort((a, b) => a.length - b.length)
      return contains[0]
    }

    return requested
  }
}
