import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import {
  getMetatraderApi,
  hasMetatraderApiConfigured,
  mtPlatformFrom,
  MetatraderApiClient,
  MtOperation,
  normalizeSymbolParams,
  OrderSendArgs,
  SymbolParams,
} from './metatraderapi'
import {
  clampPendingExpiryHours,
  computeCwOverrideTp,
  parsedHasExplicitEntryAnchor,
  planManualOrders,
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  signalEntryPriceStrictEnabled,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
  strictSignalEntryQuoteAllowsImmediate,
  lastPositiveParsedTpPrice,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerPartialTp,
  type PlannerResult,
  type VirtualPendingLeg,
} from './manualPlanner'
import { findActiveNewsBlackout } from './newsTrading/blackout'
import { getCalendarEventsCached } from './newsTrading/calendarProvider'
import { isNewsTradingEnabled } from './newsTrading/settings'
import { autoManagementTradeSnapshot } from './autoManagement'
import {
  filterTradesWithinPipsOfReference,
  referencePriceForDirection,
} from './closeWorseEntries'
import {
  isChannelManagementBlocked,
  isOppositeSignalCloseBlocked,
  isPendingCancelBlocked,
  normalizeChannelMessageFiltersMap,
  type ChannelMessageFiltersMap,
} from './channelMessageFilters'
import { pipCalculator } from './pipCalculator'
import { trailingTradeRowSnapshot } from './trailingStop'
import { isPostgresDuplicateKeyError } from './rangePendingLegPersist'
import { cancelSignalEntryRowAtBroker, type SignalEntryPendingRow } from './signalEntryPendingHelpers'
import {
  computeBasketMergeLinkContext,
  type BasketMergeLinkContext,
  MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
} from './signalMergeLink'
import type { UserSessionManager } from './sessionManager'
import {
  buildPerLegStopTargets,
  legacyMergeLinkingEnabled,
  mergePlanImmediateOrders,
  resolveLatestOpenBasketAnchor,
  shouldRouteAsBasketParameterRefresh,
  type MergeModifySummary,
} from './multiTradeMerge'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import {
  classifyGhostBasketLegs,
  closeStaleOpenTrades,
  fetchOpenBrokerTickets,
  fetchOpenBrokerTicketsStrict,
  GHOST_BASKET_CLOSED_USER_MESSAGE,
  markBasketReconcileDone,
  markBasketReconcileDoneForAnchor,
  runBasketLegModifies,
  upsertBasketReconcileJob,
  type BasketOpenLeg,
  type BasketSymbolParams,
} from './basketSlTpReconcile'
import { syncRangePendingLadderOnBasketRefresh } from './rangePendingLadderSync'
import { channelMatchesBrokerSignal } from './brokerChannelFilter'

/** When true (default), channel-attached signals only execute if MTProto is connected in this process. */
function telegramLiveTradeGateEnabled(): boolean {
  const v = String(process.env.WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES ?? 'true').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

/** Per-broker summary so `handleSignal` can flip `signals.status` when every account skips entry-strict. */
type SendOrderOutcome = {
  openedOrMerged?: boolean
  signalEntryRequiredSkip?: boolean
}

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
  created_at?: string
  telegram_message_id?: string | null
  reply_to_message_id?: string | null
}

interface RangePendingCancelScope {
  signalId: string
  brokerAccountId: string
  symbol: string
}

/** Merge path ran (cancel + re-insert virtuals under anchor); caller must not fall through to standard sendOrder. */
type MergeOutcome =
  | { handled: false }
  | { handled: true; success: boolean }

interface BrokerRow {
  id: string
  user_id: string
  is_active: boolean
  platform: string
  connection_status?: string | null
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
  performance_baseline_balance?: number | null
  channel_message_filters?: ChannelMessageFiltersMap | null
}

interface SymbolCacheEntry {
  digits: number
  point: number
  minLot: number
  maxLot: number
  lotStep: number
  /**
   * Units in 1.00 standard lot — e.g. 100,000 for FX majors, 100 oz for
   * XAUUSD (or 10 oz on exotic brokers). Plumbed through to the planner so
   * the pip calculator can derive the correct dollar pip value per lot for
   * SL/TP, range step, and UI risk hints. `null` when /SymbolParams didn't
   * report it; the calculator falls back to a class-conventional default.
   */
  contractSize: number | null
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
  const hasEntry = parsedHasExplicitEntryAnchor(signal)
  if (a === 'buy') return hasEntry ? 'BuyLimit' : 'Buy'
  if (a === 'sell') return hasEntry ? 'SellLimit' : 'Sell'
  return null
}

function isManagementAction(action: string): boolean {
  const a = action.toLowerCase()
  return a === 'close'
    || a === 'close_worse_entries'
    || a === 'breakeven'
    || a === 'partial_profit'
    || a === 'partial_breakeven'
    || a === 'modify'
}

function computeLot(broker: BrokerRow, signal: ParsedSignal): number {
  const mode = broker.copier_mode ?? 'ai'
  if (mode === 'manual') {
    const m = (broker.manual_settings ?? {}) as ManualSettings
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
  /**
   * Set on CWE-eligible immediates so the post-OrderSend `trades.cwe_close_price`
   * INSERT carries the worker-managed close threshold. NULL when the leg is
   * not part of the close-worse-entries basket.
   */
  cweClosePrice?: number | null
  /**
   * Per-TP partial close schedule emitted by `planSinglePartialTps` for
   * `trade_style === 'single'`. Empty / undefined for multi-trade legs.
   * The executor INSERTs one `partial_tp_legs` row per entry after the
   * parent OrderSend's trade row is committed.
   */
  partialTps?: PlannerPartialTp[]
}

/**
 * Compute the single CWE override TP price for this plan against the resolved
 * anchor. The executor applies this same value to the first N immediate orders
 * on immediate legs before
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

/** Best-effort open time from /OpenedOrders row (MetaTraderAPI shapes vary). */
function brokerOrderOpenMs(o: Record<string, unknown>): number | null {
  const candidates = [
    o.timeSetup,
    o.TimeSetup,
    o.setupTime,
    o.SetupTime,
    o.time,
    o.Time,
    o.openTime,
    o.OpenTime,
    o.created,
    o.Created,
  ]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      return c > 1e12 ? c : c * 1000
    }
    if (typeof c === 'string' && c.trim()) {
      const p = Date.parse(c)
      if (Number.isFinite(p)) return p
    }
  }
  return null
}

export class TradeExecutor {
  private timer: NodeJS.Timeout | null = null
  /** Cancels TSCopier broker pendings past `pending_expiry_hours` (1–24) when env enabled. */
  private brokerPendingSweepTimer: NodeJS.Timeout | null = null
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
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly sessionManager?: UserSessionManager,
  ) {
    if (!hasMetatraderApiConfigured()) {
      console.warn('[tradeExecutor] MT4API_BASIC_USER/PASSWORD missing — trade execution disabled.')
    }
  }

  private apiFor(broker: BrokerRow): MetatraderApiClient | null {
    return getMetatraderApi(mtPlatformFrom(broker.platform))
  }

  private apiForUuid(uuid: string): MetatraderApiClient | null {
    for (const b of this.brokersById.values()) {
      if (b.metaapi_account_id === uuid) return this.apiFor(b)
    }
    return getMetatraderApi('MT5')
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
    this.brokerPendingSweepTimer = setInterval(() => {
      this.sweepExpiredTscopierBrokerPendings().catch(err =>
        console.error('[tradeExecutor] broker pending TTL sweep failed:', err),
      )
    }, 5 * 60_000)
    this.brokerPendingSweepTimer.unref?.()
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
    if (this.brokerPendingSweepTimer) clearInterval(this.brokerPendingSweepTimer)
    this.brokerPendingSweepTimer = null
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
    const pingOnStart = String(process.env.BROKER_PING_ON_WORKER_START ?? 'true').toLowerCase()
    if (pingOnStart !== 'false' && pingOnStart !== '0') {
      await this.reconnectCachedBrokers()
    }
  }

  private async reconnectCachedBrokers() {
    for (const row of this.brokersById.values()) {
      const uuid = row.metaapi_account_id
      if (!uuid || uuid.includes('|')) continue
      const api = this.apiFor(row)
      if (!api) continue
      const alive = await api.keepSessionAlive(uuid)
      if (alive) {
        if (row.connection_status !== 'connected') {
          await this.supabase
            .from('broker_accounts')
            .update({ connection_status: 'connected' })
            .eq('id', row.id)
        }
      } else {
        console.warn(`[tradeExecutor] session down for broker=${row.id}`)
        if (row.connection_status !== 'error') {
          await this.supabase
            .from('broker_accounts')
            .update({ connection_status: 'error' })
            .eq('id', row.id)
        }
      }
    }
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
      .select(
        'id,user_id,channel_id,parsed_data,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id',
      )
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
    if (!hasMetatraderApiConfigured()) return
    if (this.inflight.has(row.id)) return
    if (telegramLiveTradeGateEnabled() && row.channel_id) {
      if (!this.sessionManager?.canExecuteTelegramCopierTrades(row.user_id)) {
        if (String(process.env.WORKER_LOG_TELEGRAM_TRADE_GATE ?? '').toLowerCase() === 'true') {
          console.log(
            `[tradeExecutor] skip signal ${row.id} (user ${row.user_id}): telegram listener not live for channel-backed copier`,
          )
        }
        return
      }
    }
    this.inflight.add(row.id)
    try {
      const parsed = row.parsed_data
      if (!parsed || !parsed.action) return
      const action = String(parsed.action).toLowerCase()
      if (action === 'ignore') return

      const brokers = (this.brokersByUser.get(row.user_id) ?? []).filter(b =>
        b.is_active && isMtUuid(b.metaapi_account_id) && channelMatchesBrokerSignal(b, row.channel_id),
      )
      if (!brokers.length) {
        console.warn(
          `[tradeExecutor] skip signal ${row.id}: no active broker matches channel=${row.channel_id ?? 'none'} (check Configure Trading channel selection)`,
        )
        return
      }

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
        const mgmtBrokers = brokers.filter(
          b => !isChannelManagementBlocked(
            normalizeChannelMessageFiltersMap(b.channel_message_filters),
            row.channel_id,
            action,
          ),
        )
        if (!mgmtBrokers.length) {
          try {
            await this.supabase
              .from('signals')
              .update({ status: 'skipped', skip_reason: 'channel_filter_ignored' })
              .eq('id', row.id)
              .eq('status', 'parsed')
          } catch { /* best-effort */ }
          return
        }
        await this.applyManagement(row, parsed, mgmtBrokers)
        return
      }

      const op = operationFor(action, parsed)
      if (!op || !parsed.symbol) return

      const outcomes = await Promise.all(
        brokers.map(b => this.sendOrder(row, parsed, op, b, channelKeywords)),
      )
      const anyOpened = outcomes.some(o => o.openedOrMerged === true)
      const strictSkips = outcomes.filter(o => o.signalEntryRequiredSkip === true).length
      if (!anyOpened && strictSkips === brokers.length && strictSkips > 0) {
        try {
          const { error: sigErr } = await this.supabase
            .from('signals')
            .update({ status: 'skipped', skip_reason: SKIP_REASON_SIGNAL_ENTRY_REQUIRED })
            .eq('id', row.id)
            .eq('status', 'parsed')
          if (sigErr) {
            console.warn(`[tradeExecutor] signal skip finalize failed id=${row.id}: ${sigErr.message}`)
          }
        } catch {
          // best-effort
        }
      }
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

  /**
   * When DB shows open legs but /OpenedOrders has none of their tickets, close stale rows
   * so merge/modify paths do not block new OrderSend.
   */
  private async reconcileGhostBasketLegs(args: {
    signal: SignalRow
    broker: BrokerRow
    uuid: string
    anchorSignalId: string
    symbol: string
    familyTrades: BasketOpenLeg[]
  }): Promise<{ isGhostBasket: boolean; closedCount: number }> {
    const { signal, broker, uuid, anchorSignalId, symbol, familyTrades } = args
    if (!familyTrades.length) return { isGhostBasket: false, closedCount: 0 }
    const api = this.apiFor(broker)
    if (!api) return { isGhostBasket: false, closedCount: 0 }
    const alive = await api.keepSessionAlive(uuid)
    if (!alive) return { isGhostBasket: false, closedCount: 0 }

    let brokerTickets: Set<number>
    try {
      brokerTickets = await fetchOpenBrokerTicketsStrict(api, uuid)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[tradeExecutor] ghost basket check skipped broker=${broker.id} anchor=${anchorSignalId}: ${msg}`,
      )
      return { isGhostBasket: false, closedCount: 0 }
    }

    const { onBroker, ghost } = classifyGhostBasketLegs(familyTrades, brokerTickets)
    if (onBroker.length > 0) return { isGhostBasket: false, closedCount: 0 }
    if (!ghost.length) return { isGhostBasket: false, closedCount: 0 }

    const closedCount = await closeStaleOpenTrades(
      this.supabase,
      ghost.map(tr => tr.id),
    )
    await markBasketReconcileDoneForAnchor(this.supabase, broker.id, anchorSignalId)

    console.log(
      `[tradeExecutor] stale_basket_reconciled signal=${signal.id} broker=${broker.id}`
      + ` anchor=${anchorSignalId} symbol=${symbol} closed=${closedCount}/${ghost.length}`,
    )

    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'stale_basket_reconciled',
        status: 'success',
        request_payload: {
          anchor_signal_id: anchorSignalId,
          symbol,
          closed_count: closedCount,
          ghost_leg_count: ghost.length,
          user_message: GHOST_BASKET_CLOSED_USER_MESSAGE,
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    return { isGhostBasket: true, closedCount }
  }

  /**
   * Walk `signals.parent_signal_id` from the merge row's immediate parent upward.
   * True if `anchorSignalId` appears (multi-hop Telegram reply threads where
   * `parent_signal_id` points at an intermediate signal, not the basket anchor).
   */
  private async parentSignalIdChainContainsAnchor(
    startParentId: string | null | undefined,
    anchorSignalId: string,
  ): Promise<boolean> {
    const anchor = String(anchorSignalId).trim()
    if (!anchor) return false
    let cur: string | null =
      startParentId != null && String(startParentId).trim() ? String(startParentId).trim() : null
    const seen = new Set<string>()
    const maxDepth = 32
    for (let depth = 0; depth < maxDepth && cur; depth++) {
      if (cur === anchor) return true
      if (seen.has(cur)) break
      seen.add(cur)
      try {
        const { data } = await this.supabase
          .from('signals')
          .select('parent_signal_id')
          .eq('id', cur)
          .maybeSingle()
        const raw = (data as { parent_signal_id?: string | null } | null)?.parent_signal_id
        cur = raw != null && String(raw).trim() ? String(raw).trim() : null
      } catch {
        break
      }
    }
    return false
  }

  /**
   * Resolve which `signals.id` owns open `trades` for management and implicit merge.
   * Walks `parent_signal_id` upward first; falls back to same-channel + symbol disambiguation.
   */
  private async resolveBasketAnchorSignalIdForOpenTrades(args: {
    userId: string
    brokerAccountIds: string[]
    channelId: string | null
    parentSignalId: string | null
    symbolHint: string | null
  }): Promise<string | null> {
    const { userId, brokerAccountIds, channelId, parentSignalId, symbolHint } = args
    if (!brokerAccountIds.length) return null

    const chainIds: string[] = []
    let cur = parentSignalId != null && String(parentSignalId).trim() ? String(parentSignalId).trim() : null
    const seenWalk = new Set<string>()
    for (let d = 0; d < 32 && cur; d++) {
      if (seenWalk.has(cur)) break
      seenWalk.add(cur)
      chainIds.push(cur)
      try {
        const { data } = await this.supabase
          .from('signals')
          .select('parent_signal_id')
          .eq('id', cur)
          .maybeSingle()
        const raw = (data as { parent_signal_id?: string | null } | null)?.parent_signal_id
        cur = raw != null && String(raw).trim() ? String(raw).trim() : null
      } catch {
        break
      }
    }

    if (chainIds.length) {
      const { data: hit } = await this.supabase
        .from('trades')
        .select('signal_id')
        .eq('user_id', userId)
        .in('broker_account_id', brokerAccountIds)
        .eq('status', 'open')
        .in('signal_id', chainIds)
        .limit(80)
      const uniq = new Set((hit ?? []).map((r: { signal_id: string }) => r.signal_id))
      if (uniq.size === 1) return [...uniq][0]!
      if (uniq.size > 1) {
        console.warn(
          `[tradeExecutor] resolveBasketAnchor: multiple anchors in parent chain user=${userId} chain=${chainIds.length}`,
        )
        return null
      }
    }

    if (!channelId) return null
    const symUp = symbolHint ? symbolHint.trim().toUpperCase() : ''

    const { data: openRows } = await this.supabase
      .from('trades')
      .select('signal_id, symbol')
      .eq('user_id', userId)
      .in('broker_account_id', brokerAccountIds)
      .eq('status', 'open')
      .limit(200)

    let cand = (openRows ?? []) as { signal_id: string; symbol: string }[]
    if (symUp) cand = cand.filter(t => String(t.symbol ?? '').toUpperCase() === symUp)
    const candSigIds = [...new Set(cand.map(t => t.signal_id))]
    if (!candSigIds.length) return null

    const { data: sigRows } = await this.supabase
      .from('signals')
      .select('id, channel_id')
      .in('id', candSigIds)
    const inChannel = new Set(
      (sigRows ?? [])
        .filter((s: { id: string; channel_id: string | null }) => s.channel_id === channelId)
        .map((s: { id: string }) => s.id),
    )
    const anchors = [...new Set(cand.filter(t => inChannel.has(t.signal_id)).map(t => t.signal_id))]
    if (anchors.length === 1) return anchors[0]!
    if (anchors.length > 1) {
      console.warn(
        `[tradeExecutor] resolveBasketAnchor: ambiguous channel+symbol open baskets user=${userId} channel=${channelId}`,
      )
    }
    return null
  }

  private async manualDispatchAlreadyMaterialized(signalId: string, brokerAccountId: string): Promise<boolean> {
    const [{ count: rc, error: re }, { count: sc, error: se }] = await Promise.all([
      this.supabase
        .from('range_pending_legs')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId),
      this.supabase
        .from('signal_entry_pending_orders')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId)
        .eq('status', 'broker_pending'),
    ])
    if (re) {
      console.warn(
        `[tradeExecutor] range_pending idempotency count failed signal=${signalId} broker=${brokerAccountId}: ${re.message}`,
      )
    }
    if (se) {
      console.warn(
        `[tradeExecutor] signal_entry_pending idempotency count failed signal=${signalId} broker=${brokerAccountId}: ${se.message}`,
      )
    }
    return ((rc ?? 0) > 0 || (sc ?? 0) > 0)
  }

  private async cancelSignalEntryBrokerRowsForScope(
    scope: RangePendingCancelScope,
    userId: string,
    logSignalId: string,
    reason: string,
  ): Promise<void> {
    const { data: seRows, error } = await this.supabase
      .from('signal_entry_pending_orders')
      .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,trade_id,broker_ticket,is_buy')
      .eq('signal_id', scope.signalId)
      .eq('broker_account_id', scope.brokerAccountId)
      .eq('status', 'broker_pending')
    if (error) {
      console.warn(
        `[tradeExecutor] signal_entry_pending_orders cancel select failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${error.message}`,
      )
      return
    }
    for (const r of (seRows ?? []) as SignalEntryPendingRow[]) {
      const api = this.apiForUuid(r.metaapi_account_id)
      if (api) {
        await cancelSignalEntryRowAtBroker(this.supabase, api, r, reason)
      } else {
        await this.supabase
          .from('signal_entry_pending_orders')
          .update({
            cancel_requested_at: new Date().toISOString(),
            cancel_reason: reason,
            updated_at: new Date().toISOString(),
          })
          .eq('id', r.id)
          .eq('status', 'broker_pending')
      }
    }
  }

  private async cancelRangePendingLegsForScopes(
    userId: string,
    logSignalId: string,
    scopes: RangePendingCancelScope[],
    reason: string,
  ): Promise<void> {
    const uniq = new Map<string, RangePendingCancelScope>()
    for (const s of scopes) {
      uniq.set(`${s.signalId}|${s.brokerAccountId}|${s.symbol}`, s)
    }
    await Promise.allSettled(
      [...uniq.values()].map(async scope => {
        try {
          const { data: cancelled, error: cancelErr } = await this.supabase
            .from('range_pending_legs')
            .delete()
            .eq('signal_id', scope.signalId)
            .eq('broker_account_id', scope.brokerAccountId)
            .eq('symbol', scope.symbol)
            .select('id')
          if (cancelErr) {
            console.warn(
              `[tradeExecutor] range_pending_legs cancel failed signal=${scope.signalId} broker=${scope.brokerAccountId} symbol=${scope.symbol}: ${cancelErr.message}`,
            )
            return
          }
          const rowsCancelled = (cancelled ?? []) as Array<{ id: string }>
          if (rowsCancelled.length) {
            try {
              await this.supabase.from('trade_execution_logs').insert({
                user_id: userId,
                signal_id: logSignalId,
                broker_account_id: scope.brokerAccountId,
                action: 'virtual_pending_cancelled',
                status: 'success',
                request_payload: {
                  reason,
                  parent_signal_id: scope.signalId,
                  symbol: scope.symbol,
                  rows: rowsCancelled.length,
                  leg_ids: rowsCancelled.map(r => r.id),
                } as unknown as Record<string, unknown>,
              })
            } catch {
              // Logging failure is non-fatal.
            }
          }
          await this.cancelSignalEntryBrokerRowsForScope(scope, userId, logSignalId, reason)
        } catch {
          // best-effort
        }
      }),
    )
  }

  /**
   * Persist virtual ladder rows. Batch `upsert` can fail against a partial unique
   * index if PostgREST's conflict target does not match Postgres; fall back to
   * per-row `insert` and treat duplicate-key as success (idempotent retries).
   */
  private async persistRangePendingLegRows(
    rows: Record<string, unknown>[],
    context: string,
  ): Promise<{ ok: boolean; lastError?: string }> {
    if (!rows.length) return { ok: true }
    let { error } = await this.supabase.from('range_pending_legs').upsert(rows, {
      onConflict: 'signal_id,broker_account_id,symbol,step_idx',
      ignoreDuplicates: true,
    })
    if (!error) return { ok: true }
    const msg0 = error.message ?? String(error)
    console.warn(
      `[tradeExecutor] range_pending_legs upsert failed (${context}), trying per-row: ${msg0}`,
    )
    let lastError = msg0
    let anyHardFailure = false
    for (const row of rows) {
      const { error: e } = await this.supabase.from('range_pending_legs').insert([row])
      if (!e) continue
      const m = e.message ?? String(e)
      lastError = m
      if (isPostgresDuplicateKeyError(e)) continue
      anyHardFailure = true
      console.warn(
        `[tradeExecutor] range_pending_legs insert failed (${context}) step=${String(row.step_idx)}: ${m}`,
      )
    }
    return { ok: !anyHardFailure, lastError: anyHardFailure ? lastError : undefined }
  }

  /**
   * Manual mode: when enabled, close every open trade on this symbol that faces
   * the opposite way from the **channel** buy/sell (before reverse / planner flip).
   */
  private async closeOppositeDirectionTrades(
    signal: SignalRow,
    parsed: ParsedSignal,
    broker: BrokerRow,
    symbol: string,
  ): Promise<void> {
    if (!hasMetatraderApiConfigured()) return
    const manual = (broker.manual_settings ?? {}) as ManualSettings
    if (manual.close_on_opposite_signal !== true) return
    if (isOppositeSignalCloseBlocked(
      normalizeChannelMessageFiltersMap(broker.channel_message_filters),
      signal.channel_id,
    )) return
    const a = String(parsed.action ?? '').toLowerCase()
    if (a !== 'buy' && a !== 'sell') return
    const channelBuy = a === 'buy'
    const oppDir = channelBuy ? 'sell' : 'buy'
    const uuid = broker.metaapi_account_id!
    const api = this.apiFor(broker)
    if (!api) return
    const { data: opposites } = await this.supabase
      .from('trades')
      .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size')
      .eq('broker_account_id', broker.id)
      .eq('symbol', symbol)
      .eq('status', 'open')
      .eq('direction', oppDir)
    const rows = opposites ?? []
    if (!rows.length) return

    const scopes: RangePendingCancelScope[] = []
    for (const t of rows) {
      const ticket = Number(t.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) continue
      try {
        await api.orderClose(uuid, { ticket })
        await this.supabase
          .from('trades')
          .update({ status: 'closed', closed_at: new Date().toISOString() })
          .eq('id', t.id)
        scopes.push({ signalId: t.signal_id, brokerAccountId: broker.id, symbol })
        try {
          await this.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'opposite_signal_close',
            status: 'success',
            request_payload: {
              closed_trade_id: t.id,
              ticket,
              direction: t.direction,
              channel_action: a,
              symbol,
            } as unknown as Record<string, unknown>,
          })
        } catch {
          // logging best-effort
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[tradeExecutor] opposite_signal_close failed trade=${t.id} ticket=${ticket} broker=${broker.id}: ${msg}`,
        )
        try {
          await this.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'opposite_signal_close',
            status: 'failed',
            request_payload: { closed_trade_id: t.id, ticket, symbol } as unknown as Record<string, unknown>,
            error_message: msg,
          })
        } catch {
          // best-effort
        }
      }
    }
    if (scopes.length && !isPendingCancelBlocked(
      normalizeChannelMessageFiltersMap(broker.channel_message_filters),
      signal.channel_id,
    )) {
      await this.cancelRangePendingLegsForScopes(signal.user_id, signal.id, scopes, 'opposite_signal_close')
    }
  }

  /** Realtime payloads may omit reply/parent fields — load authoritative signal row for merge linking. */
  private async loadMergeSignalForLinking(signal: SignalRow): Promise<SignalRow> {
    try {
      const { data: fullSig } = await this.supabase
        .from('signals')
        .select('created_at, reply_to_message_id, telegram_message_id, parent_signal_id, channel_id')
        .eq('id', signal.id)
        .maybeSingle()
      const row = fullSig as {
        created_at?: string
        reply_to_message_id?: string | null
        telegram_message_id?: string | null
        parent_signal_id?: string | null
        channel_id?: string | null
      } | null
      if (!row) return signal
      return {
        ...signal,
        created_at: signal.created_at ?? row.created_at,
        reply_to_message_id: signal.reply_to_message_id ?? row.reply_to_message_id ?? null,
        telegram_message_id: signal.telegram_message_id ?? row.telegram_message_id ?? null,
        parent_signal_id: signal.parent_signal_id ?? row.parent_signal_id ?? null,
        channel_id: signal.channel_id ?? row.channel_id ?? null,
      }
    } catch {
      return signal
    }
  }

  private async resolveBasketMergeLinkContext(args: {
    mergeSignal: SignalRow
    anchorSignalId: string
    newestTradeOpenedAt: string
    parsed: ParsedSignal
  }): Promise<BasketMergeLinkContext> {
    const { mergeSignal, anchorSignalId, newestTradeOpenedAt, parsed } = args
    const { data: origSig } = await this.supabase
      .from('signals')
      .select('telegram_message_id, channel_id')
      .eq('id', anchorSignalId)
      .maybeSingle()
    const origTg = String(origSig?.telegram_message_id ?? '').trim()
    const anchorChannelId = String((origSig as { channel_id?: string | null } | null)?.channel_id ?? '').trim() || null
    const replyTo = String(mergeSignal.reply_to_message_id ?? '').trim()
    const parentLinksAnchor = String(mergeSignal.parent_signal_id ?? '') === anchorSignalId
    let ancestorChainContainsAnchor = false
    if (replyTo && !parentLinksAnchor) {
      ancestorChainContainsAnchor = await this.parentSignalIdChainContainsAnchor(
        mergeSignal.parent_signal_id,
        anchorSignalId,
      )
    }
    const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
    const hasTp = Array.isArray(parsed.tp)
      && parsed.tp.some(t => typeof t === 'number' && Number.isFinite(t) && (t as number) > 0)
    const sigTime = mergeSignal.created_at ? new Date(mergeSignal.created_at).getTime() : Date.now()
    return computeBasketMergeLinkContext({
      signalCreatedAtMs: sigTime,
      newestTradeOpenedAtMs: new Date(newestTradeOpenedAt).getTime(),
      replyToTelegramId: replyTo,
      anchorTelegramMessageId: origTg,
      mergeChannelId: String(mergeSignal.channel_id ?? '').trim() || null,
      anchorChannelId,
      parentSignalId: mergeSignal.parent_signal_id,
      anchorSignalId,
      hasSl,
      hasTp,
      ancestorChainContainsAnchor,
    })
  }

  /**
   * Parameter follow-up (SL/TP on a linked prior entry): refresh the latest open basket.
   * Fresh one-shot entries with SL/TP skip this path and use OrderSend.
   */
  private async tryParameterFollowUpMergeModifyOnly(args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
  }): Promise<MergeOutcome> {
    const { signal, parsed, broker, channelKeywords, baseLot, params, symbol, uuid, strictEntryPrefetch } = args
    if (!hasMetatraderApiConfigured()) return { handled: false }
    if (!shouldRouteAsBasketParameterRefresh(parsed)) return { handled: false }
    const api = this.apiFor(broker)
    if (!api) return { handled: false }

    const a = String(parsed.action ?? '').toLowerCase()
    if (a !== 'buy' && a !== 'sell') return { handled: false }
    const direction = a === 'buy' ? 'buy' : 'sell'

    const anchor = await resolveLatestOpenBasketAnchor(this.supabase, {
      userId: signal.user_id,
      brokerAccountId: broker.id,
      brokerSymbol: symbol,
      signalSymbol: parsed.symbol,
      direction,
      channelId: signal.channel_id,
    })
    if (!anchor) {
      try {
        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'merge_routed_modify_only',
          status: 'skipped',
          request_payload: {
            skip_reason: 'parameter_follow_up_no_open_basket',
            symbol,
            direction,
            channel_id: signal.channel_id,
          } as unknown as Record<string, unknown>,
        })
      } catch { /* best-effort */ }
      return { handled: false }
    }

    const mergeSignal = await this.loadMergeSignalForLinking(signal)
    const link = await this.resolveBasketMergeLinkContext({
      mergeSignal,
      anchorSignalId: anchor.anchorSignalId,
      newestTradeOpenedAt: anchor.newestOpenedAt,
      parsed,
    })
    if (!link.isLinked) {
      try {
        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'merge_routed_modify_only',
          status: 'skipped',
          request_payload: {
            skip_reason: 'parameter_follow_up_not_linked',
            symbol,
            direction,
            channel_id: signal.channel_id,
            anchor_signal_id: anchor.anchorSignalId,
            dt_ms: link.dtMs,
          } as unknown as Record<string, unknown>,
        })
      } catch { /* best-effort */ }
      return { handled: false }
    }

    console.log(
      `[tradeExecutor] merge_anchor_selected signal=${signal.id} broker=${broker.id}`
      + ` anchor=${anchor.anchorSignalId} symbol=${symbol} direction=${direction}`,
    )

    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'merge_anchor_selected',
        status: 'success',
        request_payload: {
          anchor_signal_id: anchor.anchorSignalId,
          symbol,
          direction,
          channel_id: signal.channel_id,
          newest_opened_at: anchor.newestOpenedAt,
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    const { data: anchorFamilyRows } = await this.supabase
      .from('trades')
      .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
      .eq('broker_account_id', broker.id)
      .eq('signal_id', anchor.anchorSignalId)
      .eq('status', 'open')
      .order('opened_at', { ascending: true })
      .limit(500)
    const anchorFamily = ((anchorFamilyRows ?? []) as BasketOpenLeg[]).filter(tr =>
      symbolsCompatibleForBasket(parsed.symbol ?? symbol, tr.symbol)
      || symbolsCompatibleForBasket(symbol, tr.symbol),
    )
    const ghostCheck = await this.reconcileGhostBasketLegs({
      signal,
      broker,
      uuid,
      anchorSignalId: anchor.anchorSignalId,
      symbol,
      familyTrades: anchorFamily,
    })
    if (ghostCheck.isGhostBasket) {
      return { handled: false }
    }

    const outcome = await this.applyBasketSlTpRefresh({
      signal,
      parsed,
      broker,
      channelKeywords,
      baseLot,
      params,
      symbol,
      uuid,
      strictEntryPrefetch,
      anchorSignalId: anchor.anchorSignalId,
      direction,
      logAction: 'merge_routed_modify_only',
      mergeLinkMeta: {
        reply_chain: link.replyOk,
        within_time_window: link.withinWindow,
        parent_links_anchor: link.parentLinksAnchor,
        thread_links_anchor: link.threadLinksAnchor,
        implicit_bundle_within_tight_window: link.implicitBundleWithinTightWindow,
        implicit_same_channel_bundle: link.implicitSameChannelBundle,
        parameter_refresh_same_channel: link.parameterRefreshSameChannel,
        implicit_bundle_dt_ms: link.dtMs,
        merge_implicit_tight_window_ms: MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
        legacy_merge_linking: legacyMergeLinkingEnabled(),
      },
    })
    return { handled: true, success: outcome.success }
  }

  /**
   * OrderModify every open leg in the basket + refresh range ladder rows. No OrderSend.
   */
  private async applyBasketSlTpRefresh(args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
    anchorSignalId: string
    direction: 'buy' | 'sell'
    logAction: 'merge_routed_modify_only' | 'signal_merge_into_open_trade'
    mergeLinkMeta?: Record<string, unknown>
  }): Promise<{ success: boolean; summary: MergeModifySummary }> {
    const {
      signal, parsed, broker, channelKeywords, baseLot, params, symbol, uuid,
      strictEntryPrefetch, anchorSignalId, direction, logAction, mergeLinkMeta,
    } = args
    const api = this.apiFor(broker)
    if (!api) {
      return {
        success: false,
        summary: { openLegs: 0, attempted: 0, modified: 0, failed: 0, skippedNoTicket: 0 },
      }
    }
    const manual = (broker.manual_settings ?? {}) as ManualSettings

    const loadFamilyTrades = async (): Promise<BasketOpenLeg[]> => {
      const { data: familyRows, error: famErr } = await this.supabase
        .from('trades')
        .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
        .eq('broker_account_id', broker.id)
        .eq('signal_id', anchorSignalId)
        .eq('status', 'open')
        .order('opened_at', { ascending: true })
        .limit(500)
      if (famErr) {
        console.warn(
          `[tradeExecutor] basket refresh load trades failed signal=${signal.id} anchor=${anchorSignalId}: ${famErr.message}`,
        )
        return []
      }
      const symHint = parsed.symbol ?? symbol
      return ((familyRows ?? []) as BasketOpenLeg[]).filter(tr =>
        symbolsCompatibleForBasket(symHint, tr.symbol)
        || symbolsCompatibleForBasket(symbol, tr.symbol),
      )
    }

    let familyTrades = await loadFamilyTrades()
    if (!familyTrades.length) {
      return {
        success: false,
        summary: { openLegs: 0, attempted: 0, modified: 0, failed: 0, skippedNoTicket: 0 },
      }
    }

    const newest = familyTrades[familyTrades.length - 1]!
    const rpe0 = resolvedParsedEntryPrice(parsed)
    const rzo0 = resolvedParsedEntryZone(parsed)
    const plannerParsed: PlannerParsedSignal = {
      action: parsed.action,
      symbol: parsed.symbol,
      entry_price: rpe0,
      entry_zone_low: rzo0?.lo ?? parsed.entry_zone_low,
      entry_zone_high: rzo0?.hi ?? parsed.entry_zone_high,
      sl: parsed.sl,
      tp: parsed.tp,
      lot_size: parsed.lot_size,
      open_tp: parsed.open_tp,
      partial_close_fraction: parsed.partial_close_fraction,
      raw_instruction: parsed.raw_instruction,
    }
    if (!parsedHasExplicitEntryAnchor(plannerParsed)) {
      const ep = Number(newest.entry_price)
      if (Number.isFinite(ep) && ep > 0) plannerParsed.entry_price = ep
    }
    if (!parsedHasExplicitEntryAnchor(plannerParsed)) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        plannerParsed.entry_price = direction === 'buy' ? q.ask : q.bid
      } catch {
        console.warn(`[tradeExecutor] basket refresh skipped: no entry anchor signal=${signal.id}`)
        return {
          success: false,
          summary: {
            openLegs: familyTrades.length,
            attempted: 0,
            modified: 0,
            failed: 0,
            skippedNoTicket: familyTrades.length,
          },
        }
      }
    }

    const mergeBaseOp: MtOperation = direction === 'buy' ? 'Buy' : 'Sell'
    const plan = planManualOrders({
      parsed: plannerParsed,
      resolvedSymbol: symbol,
      baseOperation: mergeBaseOp,
      manual,
      channelKeywords,
      manualLot: baseLot,
      ctx: {
        point: params?.point ?? 0.00001,
        digits: params?.digits ?? 5,
        minLot: params?.minLot ?? 0.01,
        lotStep: params?.lotStep ?? 0.01,
        contractSize: params?.contractSize ?? null,
        stopsLevel: params?.stopsLevel ?? 0,
        freezeLevel: params?.freezeLevel ?? 0,
        defaultLot: Number(broker.default_lot_size ?? 0.01),
        lastBalance: broker.last_balance ?? null,
        liveBid: strictEntryPrefetch?.bid,
        liveAsk: strictEntryPrefetch?.ask,
      },
      commentPrefix: `TSCopier:${signal.id.slice(0, 8)}`,
      expertId: 909090,
      slippage: 20,
    })

    if (plan.skip_reason) {
      return {
        success: false,
        summary: {
          openLegs: familyTrades.length,
          attempted: 0,
          modified: 0,
          failed: 0,
          skippedNoTicket: 0,
        },
      }
    }

    if (plan.delay_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(plan.delay_ms, 30_000)))
    }

    let virtualPendings = (plan.virtualPendings ?? []).slice(0, 500)
    let perLegTargets = buildPerLegStopTargets({
      plan,
      parsed,
      openLegCount: familyTrades.length,
    })

    let anchor: number | null = plan.anchor?.value ?? null
    if ((virtualPendings.length > 0 || !!plan.closeWorseEntries) && (anchor == null || anchor <= 0)) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        anchor = plan.isBuy === false ? q.bid : q.ask
      } catch { /* drop virtuals below */ }
    }
    const overrideTp = computeCweTp(plan, anchor, params)
    let nImmCwe = 0
    if (overrideTp != null && plan.closeWorseEntries) {
      nImmCwe = Math.max(0, Math.min(perLegTargets.length, plan.closeWorseEntries.immediates))
      for (let i = 0; i < nImmCwe; i++) {
        if (perLegTargets[i]) perLegTargets[i]!.takeprofit = 0
      }
    }

    for (const t of familyTrades) {
      try {
        await this.supabase.from('partial_tp_legs').delete().eq('trade_id', t.id)
      } catch { /* best-effort */ }
    }

    const basketParams: BasketSymbolParams | null = params
      ? {
          digits: params.digits,
          point: params.point,
          minLot: params.minLot,
          lotStep: params.lotStep,
          contractSize: params.contractSize,
          stopsLevel: params.stopsLevel,
          freezeLevel: params.freezeLevel,
        }
      : null

    let openedTickets: Set<number> | null = null
    try {
      openedTickets = await fetchOpenBrokerTickets(api, uuid)
    } catch { /* preflight optional */ }

    const modifiedTradeIds = new Set<string>()
    let legErrors: Array<{ error: string; leg_index: number }> = []
    let summary: MergeModifySummary & { skippedNotOnBroker?: number } = {
      openLegs: familyTrades.length,
      attempted: 0,
      modified: 0,
      failed: 0,
      skippedNoTicket: 0,
      skippedNotOnBroker: 0,
    }
    const stragglerRounds = Math.min(
      12,
      Math.max(3, Number(process.env.BASKET_REFRESH_STRAGGLER_ROUNDS ?? 8)),
    )

    for (let round = 0; round < stragglerRounds; round++) {
      if (round > 0) {
        await new Promise(r => setTimeout(r, Math.min(round, 4) * 200))
        familyTrades = await loadFamilyTrades()
        summary.openLegs = familyTrades.length
        const refreshedTargets = buildPerLegStopTargets({
          plan,
          parsed,
          openLegCount: familyTrades.length,
        })
        if (refreshedTargets.length) {
          perLegTargets.length = 0
          perLegTargets.push(...refreshedTargets)
        }
        if (round === 1) {
          try {
            openedTickets = await fetchOpenBrokerTickets(api, uuid)
          } catch { /* optional */ }
        }
      }
      const pending = familyTrades.filter(tr => !modifiedTradeIds.has(tr.id))
      if (!pending.length) break
      if (round > 0 && pending.every(tr => {
        const t = Number(tr.metaapi_order_id)
        return !Number.isFinite(t) || t <= 0
      })) {
        break
      }

      const pass = await runBasketLegModifies({
        supabase: this.supabase,
        api,
        uuid,
        symbol,
        direction,
        baseLot,
        params: basketParams,
        signalId: signal.id,
        userId: signal.user_id,
        brokerAccountId: broker.id,
        familyTrades,
        perLegTargets,
        nImmCwe,
        overrideTp,
        strictEntryPrefetch,
        openedTickets,
        alreadyModified: modifiedTradeIds,
      })
      for (const id of pass.modifiedTradeIds) modifiedTradeIds.add(id)
      summary = pass.summary
      legErrors = pass.legErrors.map(e => ({ error: e.error, leg_index: e.leg_index }))
      if (modifiedTradeIds.size >= familyTrades.length) break
    }

    const stillMissingTicket = familyTrades.filter(tr => {
      const t = Number(tr.metaapi_order_id)
      return !Number.isFinite(t) || t <= 0
    }).length
    summary.skippedNoTicket = stillMissingTicket

    if (virtualPendings.length > 0 && anchor != null && Number.isFinite(anchor) && anchor > 0) {
      if (overrideTp != null && plan.closeWorseEntries) {
        const nVirt = virtualPendings.length
        for (let i = 0; i < nVirt; i++) {
          virtualPendings[i] = {
            ...virtualPendings[i]!,
            takeprofit: null,
            comment: `${virtualPendings[i]!.comment}.cw`,
            cweClosePrice: overrideTp,
          }
        }
      }
      const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
      const safe = Math.max(Number(params?.stopsLevel) || 0, Number(params?.freezeLevel) || 0)
      const zoneHi = safe > 0 ? anchor + (safe + 2) * (params?.point ?? 0) : null
      const zoneLo = safe > 0 ? anchor - (safe + 2) * (params?.point ?? 0) : null
      const nowMs = Date.now()
      const plannedImmediateLegs = Math.max(
        mergePlanImmediateOrders(plan).length,
        plan.closeWorseEntries?.immediates ?? 0,
      )
      const ladderSync = await syncRangePendingLadderOnBasketRefresh({
        supabase: this.supabase,
        scope: { signalId: anchorSignalId, brokerAccountId: broker.id, symbol },
        virtualPendings,
        openTradeCount: familyTrades.length,
        plannedImmediateLegs,
        plannedRangeLegs: virtualPendings.length,
        buildInsertRow: (v) => {
          const triggerPrice = triggerPriceFor(v, anchor, digits)
          if (zoneHi != null && zoneLo != null && triggerPrice > zoneLo && triggerPrice < zoneHi) {
            return null
          }
          const expiresAt = v.expiryHours && v.expiryHours > 0
            ? new Date(nowMs + v.expiryHours * 60 * 60 * 1000).toISOString()
            : null
          return {
            signal_id: anchorSignalId,
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
            cwe_close_price: v.cweClosePrice ?? null,
          }
        },
        persistRows: (rows, ctx) => this.persistRangePendingLegRows(rows, ctx),
        context: `basket_refresh signal=${signal.id} anchor=${anchorSignalId}`,
      })
      if (ladderSync.skippedConsumed > 0 || ladderSync.skippedCap > 0) {
        console.log(
          `[tradeExecutor] basket_refresh ladder sync signal=${signal.id} anchor=${anchorSignalId}`
          + ` updated=${ladderSync.updated} inserted=${ladderSync.inserted}`
          + ` skip_consumed=${ladderSync.skippedConsumed} skip_cap=${ladderSync.skippedCap}`,
        )
      }
    }

    let mergeFailed = summary.modified < summary.openLegs
    const skippedBroker = summary.skippedNotOnBroker ?? 0
    const allLegsGhostOnBroker =
      summary.openLegs > 0
      && skippedBroker >= summary.openLegs
      && summary.modified === 0
      && stillMissingTicket === 0

    if (allLegsGhostOnBroker) {
      const closedCount = await closeStaleOpenTrades(
        this.supabase,
        familyTrades.map(tr => tr.id),
      )
      await markBasketReconcileDoneForAnchor(this.supabase, broker.id, anchorSignalId)
      mergeFailed = true
      console.log(
        `[tradeExecutor] ghost basket closed after modify signal=${signal.id} broker=${broker.id}`
        + ` anchor=${anchorSignalId} closed=${closedCount}`,
      )
    }

    let partialMsg = mergeFailed
      ? `Not all trades were modified (${summary.modified}/${summary.openLegs} open legs`
        + `${stillMissingTicket > 0 ? `; ${stillMissingTicket} still waiting for broker ticket` : ''}`
        + `${skippedBroker > 0 ? `; ${skippedBroker} not on broker` : ''}`
        + `${summary.failed > 0 ? `; ${summary.failed} broker modify errors` : ''})`
      : null
    if (allLegsGhostOnBroker) {
      partialMsg = GHOST_BASKET_CLOSED_USER_MESSAGE
    }

    if (mergeFailed && !allLegsGhostOnBroker) {
      await upsertBasketReconcileJob(this.supabase, {
        userId: signal.user_id,
        brokerAccountId: broker.id,
        anchorSignalId,
        sourceSignalId: signal.id,
        channelId: signal.channel_id,
        symbol,
        direction,
        perLegTargets,
        familyTrades,
        virtualPendingsSnapshot: virtualPendings.length > 0 ? virtualPendings : null,
        nImmCwe,
        overrideTp,
        lastError: partialMsg,
      })
    } else {
      const { data: existingJob } = await this.supabase
        .from('basket_reconcile_jobs')
        .select('id')
        .eq('broker_account_id', broker.id)
        .eq('anchor_signal_id', anchorSignalId)
        .maybeSingle()
      if (existingJob?.id) {
        await markBasketReconcileDone(this.supabase, existingJob.id as string)
      }
    }

    console.log(
      `[tradeExecutor] merge_modify_summary signal=${signal.id} broker=${broker.id} anchor=${anchorSignalId}`
      + ` open=${summary.openLegs} attempted=${summary.attempted} modified=${summary.modified}`
      + ` failed=${summary.failed} no_ticket=${summary.skippedNoTicket}`,
    )

    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'merge_modify_summary',
        status: mergeFailed ? 'failed' : 'success',
        error_message: partialMsg,
        request_payload: {
          parent_signal_id: anchorSignalId,
          symbol,
          user_message: partialMsg,
          ...summary,
          virtual_pendings: virtualPendings.length,
          leg_errors: legErrors.slice(0, 10),
          ...(mergeLinkMeta ?? {}),
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: logAction,
        status: mergeFailed ? 'failed' : 'success',
        error_message: partialMsg,
        request_payload: {
          parent_signal_id: anchorSignalId,
          symbol,
          modify_only: true,
          user_message: partialMsg,
          ...summary,
          virtual_pendings: virtualPendings.length,
          leg_errors: legErrors.slice(0, 10),
          ...(mergeLinkMeta ?? {}),
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    if (!mergeFailed) {
      try {
        await this.supabase
          .from('signals')
          .update({ status: 'executed' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch { /* best-effort */ }
    }

    return { success: !mergeFailed, summary }
  }

  /**
   * When `add_new_trades_to_existing` is on, apply a same-direction follow-up
   * (Telegram reply to the anchor entry, reply to a thread whose parent chain
   * reaches the anchor, or time window with direct `parent_signal_id` → anchor)
   * as SL/TP refresh on all open legs of the basket (`signal_id` family).
   */
  private async tryMergeSignalIntoExistingOpenTrade(args: {
    signal: SignalRow
    parsed: ParsedSignal
    op: MtOperation
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
  }): Promise<MergeOutcome> {
    const { signal, parsed, op, broker, channelKeywords, baseLot, params, symbol, uuid, strictEntryPrefetch } = args
    if (!hasMetatraderApiConfigured()) return { handled: false }
    const api = this.apiFor(broker)
    if (!api) return { handled: false }
    const manual = (broker.manual_settings ?? {}) as ManualSettings
    if (manual.add_new_trades_to_existing !== true) return { handled: false }
    if (shouldRouteAsBasketParameterRefresh(parsed)) return { handled: false }
    if (signalEntryPriceStrictEnabled(manual) && !parsedHasExplicitEntryAnchor(parsed)) {
      return { handled: false }
    }

    const a = String(parsed.action ?? '').toLowerCase()
    if (a !== 'buy' && a !== 'sell') return { handled: false }
    const direction = a === 'buy' ? 'buy' : 'sell'

    const mergeSignal = await this.loadMergeSignalForLinking(signal)

    const { data: openDesc, error: openErr } = await this.supabase
      .from('trades')
      .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction')
      .eq('broker_account_id', broker.id)
      .eq('symbol', symbol)
      .eq('status', 'open')
      .eq('direction', direction)
      .order('opened_at', { ascending: false })
      .limit(64)
    if (openErr || !openDesc?.length) return { handled: false }

    type OpenLeg = (typeof openDesc)[0]
    const newest = openDesc[0] as OpenLeg
    const anchorSignalId = newest.signal_id
    if (!anchorSignalId) return { handled: false }

    const familyTrades = (openDesc as OpenLeg[])
      .filter(t => t.signal_id === anchorSignalId)
      .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime())
    if (!familyTrades.length) return { handled: false }

    const ghostCheck = await this.reconcileGhostBasketLegs({
      signal,
      broker,
      uuid,
      anchorSignalId,
      symbol,
      familyTrades: familyTrades as BasketOpenLeg[],
    })
    if (ghostCheck.isGhostBasket) return { handled: false }

    const link = await this.resolveBasketMergeLinkContext({
      mergeSignal,
      anchorSignalId,
      newestTradeOpenedAt: newest.opened_at,
      parsed,
    })
    if (!link.isLinked) {
      console.warn(
        `[tradeExecutor] merge not linked signal=${signal.id} broker=${broker.id} symbol=${symbol}`
        + ` reply=${link.replyOk} window=${link.withinWindow} thread=${link.threadLinksAnchor}`
        + ` implicit=${link.implicitSameChannelBundle} paramRefresh=${link.parameterRefreshSameChannel}`
        + ` dt_ms=${link.dtMs}`,
      )
      return { handled: false }
    }

    const refresh = await this.applyBasketSlTpRefresh({
      signal,
      parsed,
      broker,
      channelKeywords,
      baseLot,
      params,
      symbol,
      uuid,
      strictEntryPrefetch,
      anchorSignalId,
      direction,
      logAction: 'signal_merge_into_open_trade',
      mergeLinkMeta: {
        reply_chain: link.replyOk,
        within_time_window: link.withinWindow,
        parent_links_anchor: link.parentLinksAnchor,
        has_reply_to_telegram: Boolean(String(mergeSignal.reply_to_message_id ?? '').trim()),
        thread_links_anchor: link.threadLinksAnchor,
        implicit_bundle_within_tight_window: link.implicitBundleWithinTightWindow,
        implicit_same_channel_bundle: link.implicitSameChannelBundle,
        parameter_refresh_same_channel: link.parameterRefreshSameChannel,
        implicit_bundle_dt_ms: link.dtMs,
        merge_implicit_tight_window_ms: MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
        legacy_merge_linking: legacyMergeLinkingEnabled(),
      },
    })
    return { handled: true, success: refresh.success }
  }

  private async sweepExpiredTscopierBrokerPendings(): Promise<void> {
    if (!hasMetatraderApiConfigured()) return
    if (String(process.env.WORKER_BROKER_PENDING_EXPIRY_SWEEP ?? '').toLowerCase() !== 'true') return

    const brokers = Array.from(this.brokersById.values()).filter(b =>
      b.is_active && isMtUuid(b.metaapi_account_id) && (b.copier_mode ?? 'ai') === 'manual',
    )
    if (!brokers.length) return

    const now = Date.now()
    for (const broker of brokers) {
      const manual = (broker.manual_settings ?? {}) as ManualSettings
      const ttlH = clampPendingExpiryHours(manual.pending_expiry_hours)
      if (ttlH <= 0) continue
      const uuid = broker.metaapi_account_id!
      const api = this.apiFor(broker)
      if (!api) continue
      let orders: unknown[]
      try {
        orders = await api.openedOrders(uuid)
      } catch (err) {
        console.warn(`[tradeExecutor] TTL sweep /OpenedOrders failed broker=${broker.id}: ${(err as Error).message}`)
        continue
      }
      const cutoff = now - ttlH * 3600_000
      for (const raw of orders ?? []) {
        if (!raw || typeof raw !== 'object') continue
        const o = raw as Record<string, unknown>
        const operation = String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '')
        const comment = String(o.comment ?? o.Comment ?? '')
        const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
        if (!operation.includes('Limit') && !operation.includes('Stop')) continue
        if (!comment.startsWith('TSCopier:')) continue
        if (!Number.isFinite(ticket) || ticket <= 0) continue
        const openMs = brokerOrderOpenMs(o)
        if (openMs == null || openMs > cutoff) continue
        try {
          await api.orderClose(uuid, { ticket })
          console.log(
            `[tradeExecutor] TTL sweep closed ticket=${ticket} broker=${broker.id} op=${operation} ttl_hours=${ttlH}`,
          )
        } catch (err) {
          console.warn(`[tradeExecutor] TTL sweep close failed ticket=${ticket} broker=${broker.id}: ${(err as Error).message}`)
        }
      }
    }
  }

  private async sendOrder(
    signal: SignalRow,
    parsed: ParsedSignal,
    op: MtOperation,
    broker: BrokerRow,
    channelKeywords: ChannelKeywords | null,
  ): Promise<SendOrderOutcome> {
    if (!hasMetatraderApiConfigured()) return {}
    const api = this.apiFor(broker)
    if (!api) return {}
    const uuid = broker.metaapi_account_id!
    const alive = await api.keepSessionAlive(uuid)
    if (!alive) {
      console.warn(
        `[tradeExecutor] broker ${broker.id} session check failed before order; attempting OrderSend anyway`,
      )
    } else if (broker.connection_status !== 'connected') {
      void this.supabase
        .from('broker_accounts')
        .update({ connection_status: 'connected' })
        .eq('id', broker.id)
    }
    const mapping = applySymbolMapping(parsed.symbol!, broker)

    // Whitelist mode: when the user listed multiple symbols, only let signals
    // matching one of them through. Skip the signal otherwise.
    if (mapping.whitelist.length > 0) {
      const sig = (parsed.symbol ?? '').toUpperCase()
      if (!mapping.whitelist.includes(sig)) {
        await this.logSendSkipped(signal, broker, 'symbol_exempted_from_trading', {
          signal_symbol: parsed.symbol ?? null,
          allowed: mapping.whitelist,
        })
        return {}
      }
    }

    const requestedSymbol = mapping.symbol
    if (isExcluded(requestedSymbol, broker)) {
      await this.logSendSkipped(signal, broker, 'symbol_exempted_from_trading', {
        signal_symbol: parsed.symbol ?? null,
        trade_symbol: requestedSymbol,
        reason: 'symbols_exclude',
      })
      return {}
    }

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

    let strictEntryPrefetch: { bid: number; ask: number } | null = null
    const needsQuotePrefetch =
      isManual
      && (
        (signalEntryPriceStrictEnabled(manual) && parsedHasExplicitEntryAnchor(parsed))
        || (
          (manual.use_predefined_sl_pips === true || manual.use_predefined_tp_pips === true)
          && !parsedHasExplicitEntryAnchor(parsed)
        )
      )
    if (needsQuotePrefetch) {
      try {
        strictEntryPrefetch = await api.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[tradeExecutor] /Quote prefetch failed ${symbol} signal=${signal.id} broker=${broker.id}: ${msg}`,
        )
      }
    }

    if (isManual && manual.close_on_opposite_signal === true) {
      await this.closeOppositeDirectionTrades(signal, parsed, broker, symbol)
    }

    // Linked SL/TP follow-ups refresh an existing basket; fresh entries fall through to OrderSend.
    if (isManual && shouldRouteAsBasketParameterRefresh(parsed)) {
      const paramOutcome = await this.tryParameterFollowUpMergeModifyOnly({
        signal,
        parsed,
        broker,
        channelKeywords,
        baseLot,
        params,
        symbol,
        uuid,
        strictEntryPrefetch,
      })
      if (paramOutcome.handled && paramOutcome.success) {
        return { openedOrMerged: true }
      }
      if (paramOutcome.handled) {
        return { openedOrMerged: false }
      }
    }

    if (isManual && manual.add_new_trades_to_existing === true) {
      const mergeOutcome = await this.tryMergeSignalIntoExistingOpenTrade({
        signal,
        parsed,
        op,
        broker,
        channelKeywords,
        baseLot,
        params,
        symbol,
        uuid,
        strictEntryPrefetch,
      })
      if (mergeOutcome.handled && mergeOutcome.success) {
        return { openedOrMerged: true }
      }
    }

    // Stop here when the user opted out of stacking trades on the same symbol.
    if (isManual && manual.add_new_trades_to_existing === false) {
      const already = await this.hasOpenTradeForSymbol(broker.id, symbol)
      if (already) {
        await this.logSendSkipped(signal, broker, 'add_new_trades_to_existing=false', { symbol })
        return {}
      }
    }

    if (isManual && !isNewsTradingEnabled(manual)) {
      const events = await getCalendarEventsCached()
      const blackout = findActiveNewsBlackout(events, manual, symbol)
      if (blackout) {
        await this.logSendSkipped(signal, broker, 'filtered_news', {
          symbol,
          phase: blackout.phase,
          event: blackout.event.event,
          currency: blackout.event.currency,
        })
        return {}
      }
    }

    // Build the order list. In AI mode we keep the original single-order shape;
    // manual mode delegates to the planner so filters / multi-TP / pip-derived
    // SL & TP / pending expiry / reverse all apply consistently.
    let plan: PlannerResult
    if (isManual) {
      const rpe = resolvedParsedEntryPrice(parsed)
      const rzo = resolvedParsedEntryZone(parsed)
      const plannerParsed: PlannerParsedSignal = {
        action: parsed.action,
        symbol: parsed.symbol,
        entry_price: rpe,
        entry_zone_low: rzo?.lo ?? parsed.entry_zone_low,
        entry_zone_high: rzo?.hi ?? parsed.entry_zone_high,
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
          contractSize: params?.contractSize ?? null,
          stopsLevel: params?.stopsLevel ?? 0,
          freezeLevel: params?.freezeLevel ?? 0,
          defaultLot: Number(broker.default_lot_size ?? 0.01),
          lastBalance: broker.last_balance ?? null,
          liveBid: strictEntryPrefetch?.bid,
          liveAsk: strictEntryPrefetch?.ask,
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
          price: resolvedParsedEntryPrice(parsed) ?? 0,
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
      const entryStrict =
        isManual && plan.skip_reason === SKIP_REASON_SIGNAL_ENTRY_REQUIRED
      return entryStrict ? { signalEntryRequiredSkip: true } : {}
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
          status: 'success',
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

    if (isManual && manual.trade_style === 'multi') {
      try {
        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'multi_range_plan',
          status: 'success',
          request_payload: {
            manual_lot_used: baseLot,
            multi_trade_leg_percent: Number(manual.multi_trade_leg_percent ?? 5),
            immediate_orders: capped.length,
            virtual_pending_rows: virtualPendings.length,
            range_trading: manual.range_trading === true,
            range_percent: manual.range_percent ?? null,
            range_step_pips: manual.range_step_pips ?? null,
            range_distance_pips: manual.range_distance_pips ?? null,
            symbol,
            plan_fallback: plan.fallback_reason ?? null,
          } as unknown as Record<string, unknown>,
        })
      } catch {
        /* best-effort */
      }
    }

    if (isManual) {
      const already = await this.manualDispatchAlreadyMaterialized(signal.id, broker.id)
      if (already) {
        console.warn(
          `[tradeExecutor] skip duplicate manual dispatch signal=${signal.id} broker=${broker.id}`,
        )
        return { openedOrMerged: true }
      }
    }

    // ── Strict signal entry (post-delay live quote) ───────────────────────
    // Buy: immediate market only when ask ≤ entry; else one virtual pending at entry.
    // Sell: immediate only when bid ≥ entry; else virtual at entry. Quote failure → defer.
    let strictDeferred = false
    if (isManual && plan.strictEntry && api) {
      const se = plan.strictEntry
      try {
        const q = await api.quote(uuid, symbol)
        strictEntryPrefetch = q
        strictDeferred = !strictSignalEntryQuoteAllowsImmediate({
          isBuy: se.isBuy,
          entryPrice: se.entryPrice,
          bid: q.bid,
          ask: q.ask,
        })
        if (strictDeferred) {
          console.log(
            `[tradeExecutor] strict entry deferred signal=${signal.id} broker=${broker.id} symbol=${symbol}`
            + ` entry=${se.entryPrice} isBuy=${se.isBuy} bid=${q.bid} ask=${q.ask}`,
          )
        }
      } catch (err) {
        strictDeferred = true
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[tradeExecutor] strict entry /Quote failed; deferring to broker pending signal=${signal.id} broker=${broker.id} symbol=${symbol}: ${msg}`,
        )
      }
    }

    const effectiveCapped = strictDeferred ? [] : capped

    // Build immediate legs with rounded volumes. Immediates already carry the
    // planner's intended entry price (signal entry or zero for true market orders).
    //
    // The planner only ever emits a single-trade `partialTps` schedule when
    // `capped.length === 1` (single mode → one order). We attach it to that
    // single leg so the post-INSERT path can fan out the partials.
    const volumeRounded = effectiveCapped.map(o => ({ ...o, volume: roundLot(o.volume, params) }))
    let legs: Leg[] = volumeRounded.map((args, idx) => ({
      args,
      idx,
      ...(idx === 0 && plan.partialTps?.length ? { partialTps: plan.partialTps } : {}),
    }))

    // ── Anchor resolution ────────────────────────────────────────────────
    // Priority: parsed signal entry → live /Quote (Ask for buy, Bid for sell).
    // Needed whenever we have virtual pendings to persist (so we can compute
    // trigger prices) OR Close-Worse-Entries is on (so we can compute the
    // single override TP). Strict broker pendings use the signal entry as the
    // clamp reference — no extra quote solely for that path.
    // The Quote is a ~50-150ms GET that we issue BEFORE
    // sending immediates so every leg + every virtual trigger sees the same
    // deterministic reference price.
    const needsAnchor = virtualPendings.length > 0 || !!plan.closeWorseEntries
    let anchor: number | null = plan.anchor?.value ?? plan.strictEntry?.entryPrice ?? null
    let anchorSource: 'signal' | 'quote' | 'unknown' = plan.anchor?.source ?? 'unknown'
    if (needsAnchor && (anchor == null || anchor <= 0) && api) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        if (!strictEntryPrefetch) strictEntryPrefetch = q
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

    // Apply Close-Worse-Entries to immediate legs. As of May-12 this is a *worker-managed* close: the
    // broker never sees the threshold as a takeprofit (which produced
    // "Invalid stops" rejections whenever the basket was already in profit or
    // inside the stops/freeze zone). Instead we:
    //   1. Set takeprofit = 0 on the CWE-tagged leg's broker order so only
    //      the SL rides (the bucket TP is intentionally dropped — the user
    //      wants these worse entries to be exited by CWE, not by TP1/TP2/TP3).
    //   2. Stamp `cweClosePrice` on the leg / pending so the post-INSERT path
    //      writes it into `trades.cwe_close_price` / `range_pending_legs.cwe_close_price`.
    //   3. The new `cweCloseMonitor` polls /Quote and fires /OrderClose on
    //      every CWE-tagged open trade once the threshold is crossed.
    const overrideTp = computeCweTp(plan, anchor, params)
    if (overrideTp != null && plan.closeWorseEntries) {
      const nImm = Math.max(0, Math.min(legs.length, plan.closeWorseEntries.immediates))
      for (let i = 0; i < nImm; i++) {
        legs[i] = {
          ...legs[i]!,
          args: {
            ...legs[i]!.args,
            takeprofit: 0,
            comment: `${legs[i]!.args.comment ?? ''}.cw`,
          },
          cweClosePrice: overrideTp,
        }
      }
    }

    if (isManual) {
      // One-line plan summary so it's obvious whether Range Trading / CWE are
      // actually firing, and at which anchor. Helps debug "settings not applying".
      const point = Number(params?.point) || 0
      const stopsLevel = Number(params?.stopsLevel) || 0
      const freezeLevel = Number(params?.freezeLevel) || 0
      const pipValue = plan.pipQuote?.pipValuePerStdLot
      const contractSize = plan.pipQuote?.contractSize
      const quoteCcy = plan.pipQuote?.quoteCurrency ?? ''
      const partialCount = plan.partialTps?.length ?? 0
      console.log(
        `[tradeExecutor] manual plan signal=${signal.id} broker=${broker.id} symbol=${symbol}`
        + ` style=${manual.trade_style ?? 'single'} legs=${legs.length + virtualPendings.length}`
        + ` (immediate=${legs.length}, virtual_pending=${virtualPendings.length}${partialCount > 0 ? `, partial_tp=${partialCount}` : ''})`
        + ` rangeOn=${manual.range_trading === true} cwOn=${!!plan.closeWorseEntries}`
        + (overrideTp != null ? ` cweClose=${overrideTp}` : '')
        + ` pip=${plan.pip ?? 'n/a'}`
        + (pipValue != null ? ` pipValue=${pipValue.toFixed(4)}${quoteCcy ? '_' + quoteCcy : ''}/lot` : '')
        + (contractSize != null ? ` contractSize=${contractSize}` : '')
        + ` anchorSource=${anchorSource} anchor=${anchor ?? 'n/a'}`
        + ` stops_level=${stopsLevel} freeze_level=${freezeLevel} point=${point}`
        + (plan.fallback_reason ? ` fallback=${plan.fallback_reason}` : ''),
      )
    }

    // Strict entry: when the post-delay quote is not immediately fillable, place a
    // real BuyLimit / SellLimit on the broker at the signal entry (tracked in
    // `signal_entry_pending_orders`). Multi-mode aggregates volume into one order.
    let strictBrokerPlaced = false
    if (strictDeferred && plan.strictEntry && capped.length > 0 && api) {
      const se = plan.strictEntry
      const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
      const entryPx = Number(se.entryPrice.toFixed(digits))
      const pendHours = clampPendingExpiryHours(manual.pending_expiry_hours)
      const nowMs = Date.now()
      const expiresAt = pendHours > 0
        ? new Date(nowMs + pendHours * 60 * 60 * 1000).toISOString()
        : null
      const op: MtOperation = se.isBuy ? 'BuyLimit' : 'SellLimit'
        const first = capped[0]!
        let aggVol = 0
        for (const o of capped) aggVol += Number(o.volume) || 0
        const vol = roundLot(capped.length === 1 ? Number(first.volume) || 0 : aggVol, params)
        const baseComment = first.comment ?? `TSCopier:${signal.id.slice(0, 8)}`
        const comment = capped.length === 1 ? `${baseComment}:strictEntry` : `${baseComment}:strictEntryAgg`
        // Broker pending expiry is enforced in `signalEntryPendingMonitor` via `expires_at`
        // (MetatraderAPI GET /OrderSend rejects many `expiration` payloads for pendings).
        const isSingleTradeStyle = manual.trade_style !== 'multi'
        const takeprofitFromPlan = first.takeprofit ?? 0
        let takeprofitPx = takeprofitFromPlan
        if (isSingleTradeStyle) {
          const lastParsed = lastPositiveParsedTpPrice(parsed)
          if (lastParsed != null && lastParsed > 0) {
            takeprofitPx = lastParsed
          }
        }
        const takeprofitRounded = Number.isFinite(takeprofitPx) && takeprofitPx > 0
          ? Number(takeprofitPx.toFixed(digits))
          : 0
        const sendArgs: OrderSendArgs = {
          symbol,
          operation: op,
          volume: vol,
          price: entryPx,
          stoploss: first.stoploss ?? 0,
          takeprofit: takeprofitRounded,
          slippage: first.slippage ?? 20,
          comment,
          expertID: first.expertID ?? 909090,
        }
        const clamped = clampOrderStops(sendArgs, params)
        if (clamped.adjustments.length > 0) {
          console.warn(
            `[tradeExecutor] strict entry pending stops clamped signal=${signal.id} broker=${broker.id}: ${clamped.adjustments.join(', ')}`,
          )
        }
        try {
          const result = await api.orderSend(uuid, clamped.args)
          const ticket = result.ticket
          const isBuyLeg = se.isBuy
          const pendingSl = clamped.args.stoploss && clamped.args.stoploss > 0 ? clamped.args.stoploss : null
          const autoBeCols = autoManagementTradeSnapshot(manual, entryPx, pendingSl)
          const tradeInsert = await this.supabase
            .from('trades')
            .insert({
              user_id: signal.user_id,
              signal_id: signal.id,
              telegram_channel_id: signal.channel_id,
              broker_account_id: broker.id,
              metaapi_order_id: String(ticket),
              symbol,
              direction: isBuyLeg ? 'buy' : 'sell',
              entry_price: entryPx,
              sl: pendingSl,
              tp: clamped.args.takeprofit && clamped.args.takeprofit > 0 ? clamped.args.takeprofit : null,
              lot_size: result.lots ?? vol,
              status: 'pending',
              opened_at: new Date().toISOString(),
              cwe_close_price: null,
              ...autoBeCols,
            })
            .select('id')
            .maybeSingle()
          if (tradeInsert.error) {
            console.error(
              `[tradeExecutor] trades INSERT failed after strict pending OrderSend signal=${signal.id} broker=${broker.id} ticket=${ticket}: ${tradeInsert.error.message}`,
            )
            try {
              await api.orderClose(uuid, { ticket })
            } catch {
              /* best-effort rollback */
            }
          } else {
            const tradeId = (tradeInsert.data as { id?: string } | null)?.id ?? null
            if (!tradeId) {
              console.error(
                `[tradeExecutor] trades INSERT returned no id after strict pending OrderSend signal=${signal.id} broker=${broker.id} ticket=${ticket}`,
              )
              try {
                await api.orderClose(uuid, { ticket })
              } catch {
                /* best-effort rollback */
              }
            } else {
              const partialTpPlan =
                isSingleTradeStyle && capped.length === 1 && plan.partialTps?.length ? plan.partialTps : null
              const { error: sepErr } = await this.supabase.from('signal_entry_pending_orders').insert({
              signal_id: signal.id,
              user_id: signal.user_id,
              broker_account_id: broker.id,
              metaapi_account_id: uuid,
              symbol,
              trade_id: tradeId,
              is_buy: se.isBuy,
              operation: op,
              entry_price: entryPx,
              volume: vol,
              stoploss: clamped.args.stoploss && clamped.args.stoploss > 0 ? clamped.args.stoploss : null,
              takeprofit: clamped.args.takeprofit && clamped.args.takeprofit > 0 ? clamped.args.takeprofit : null,
              slippage: clamped.args.slippage ?? 20,
              comment: clamped.args.comment ?? comment,
              expert_id: clamped.args.expertID ?? null,
              broker_ticket: String(ticket),
              status: 'broker_pending',
              expires_at: expiresAt,
              partial_tp_plan: partialTpPlan,
            })
            if (sepErr) {
              console.error(
                `[tradeExecutor] signal_entry_pending_orders INSERT failed signal=${signal.id} broker=${broker.id}: ${sepErr.message}`,
              )
              if (tradeId) {
                await this.supabase.from('trades').delete().eq('id', tradeId)
              }
              try {
                await api.orderClose(uuid, { ticket })
              } catch {
                /* best-effort rollback */
              }
            } else {
              strictBrokerPlaced = true
              try {
                await this.supabase.from('trade_execution_logs').insert({
                  user_id: signal.user_id,
                  signal_id: signal.id,
                  broker_account_id: broker.id,
                  action: 'signal_entry_pending_placed',
                  status: 'success',
                  request_payload: {
                    ticket,
                    operation: op,
                    entry_price: entryPx,
                    volume: vol,
                    symbol,
                  } as unknown as Record<string, unknown>,
                  response_payload: { trade_id: tradeId } as unknown as Record<string, unknown>,
                })
              } catch {
                /* best-effort */
              }
            }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(
            `[tradeExecutor] strict entry broker OrderSend failed signal=${signal.id} broker=${broker.id} op=${op} price=${entryPx}: ${msg}`,
          )
          try {
            await this.supabase.from('trade_execution_logs').insert({
              user_id: signal.user_id,
              signal_id: signal.id,
              broker_account_id: broker.id,
              action: 'signal_entry_pending_failed',
              status: 'failed',
              request_payload: { operation: op, entry_price: entryPx, symbol } as unknown as Record<string, unknown>,
              error_message: msg,
            })
          } catch {
            /* best-effort */
          }
        }
    }

    // ── Materialize virtual pendings into range_pending_legs ───────────────
    // Persisted with a computed `trigger_price`; the worker monitor + edge
    // sweep race to fire each one as a MARKET OrderSend when /Quote crosses
    // the trigger. UPSERT with ignoreDuplicates leans on the partial unique
    // index (see migration 20260513140000_range_pending_unique_active_step).
    const insertRows: Record<string, unknown>[] = []
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
            // CWE-tagged pendings carry the close threshold so the
            // virtualPendingMonitor can propagate it onto the trades row
            // when the leg fires. Non-CWE pendings stay null and keep
            // their bucket TP / SL behavior untouched.
            cwe_close_price: v.cweClosePrice ?? null,
          })
        }
      }
    }
    let materializedVirtuals = false
    if (insertRows.length > 0) {
      const persist = await this.persistRangePendingLegRows(
        insertRows,
        `standard signal=${signal.id} broker=${broker.id}`,
      )
      materializedVirtuals = persist.ok
      if (!persist.ok) {
        console.error(
          `[tradeExecutor] range_pending_legs persist failed signal=${signal.id} broker=${broker.id}: ${persist.lastError ?? 'unknown'}`,
        )
        try {
          await this.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'virtual_pending_failed',
            status: 'failed',
            request_payload: { rows: insertRows.length, anchor, anchorSource } as unknown as Record<string, unknown>,
            error_message: persist.lastError ?? 'unknown',
          })
        } catch { /* logging is best-effort */ }
      } else {
        console.log(
          `[tradeExecutor] virtual pendings inserted=${insertRows.length} signal=${signal.id} broker=${broker.id} symbol=${symbol} anchor=${anchor ?? 'n/a'} (${anchorSource})`,
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
              strict_deferred: strictDeferred,
              strict_broker_pending: strictBrokerPlaced,
            } as unknown as Record<string, unknown>,
          })
        } catch { /* logging is best-effort */ }
      }
    }

    if (legs.length === 0) {
      // No immediates — virtual range ladder and/or broker strict-entry pending.
      return (materializedVirtuals || strictBrokerPlaced) ? { openedOrMerged: true } : {}
    }

    const totalCount = legs.length
    const orderLogContext: Record<string, unknown> = {
      signal_symbol: parsed.symbol ?? null,
      trade_symbol: requestedSymbol,
    }
    if (mapping.whitelist.length > 0) {
      orderLogContext.allowed_symbols = mapping.whitelist
    }

    const sendLeg = async (leg: Leg): Promise<boolean> => {
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
        const result = await api.orderSend(uuid, args)
        const latencyMs = Date.now() - t0
        console.log(
          `[tradeExecutor] OrderSend ok signal=${signal.id} broker=${broker.id} ticket=${result.ticket} leg=${leg.idx + 1}/${totalCount} price=${args.price ?? 0} ${latencyMs}ms`,
        )

        const isBuy = !args.operation.toLowerCase().includes('sell')
        const entryPx = result.openPrice ?? args.price ?? null
        const openSl = result.stopLoss ?? args.stoploss ?? null
        const trailCols = trailingTradeRowSnapshot(
          manual,
          entryPx,
          openSl,
        )
        const autoBeCols = autoManagementTradeSnapshot(manual, entryPx, openSl)
        // We need the row's id back so we can persist partial_tp_legs keyed to
        // it. `.select('id').single()` keeps the INSERT to one round trip.
        const tradeInsert = await this.supabase
          .from('trades')
          .insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            telegram_channel_id: signal.channel_id,
            broker_account_id: broker.id,
            metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
            symbol: args.symbol,
            direction: isBuy ? 'buy' : 'sell',
            entry_price: entryPx,
            sl: openSl,
            tp: result.takeProfit ?? args.takeprofit ?? null,
            lot_size: result.lots ?? args.volume,
            status: args.operation.includes('Limit') || args.operation.includes('Stop') ? 'pending' : 'open',
            opened_at: new Date().toISOString(),
            // Worker-managed Close-Worse-Entries threshold (see cweCloseMonitor).
            // Only the first N immediate legs have this; non-CWE legs leave it null
            // and ride their bucket TP / SL normally.
            cwe_close_price: leg.cweClosePrice ?? null,
            ...trailCols,
            ...autoBeCols,
          })
          .select('id')
          .maybeSingle()
        if (tradeInsert.error) {
          console.error(
            `[tradeExecutor] trades INSERT failed signal=${signal.id} broker=${broker.id} ticket=${result.ticket}: ${tradeInsert.error.message}`,
          )
        }
        const tradeRowId = (tradeInsert.data as { id?: string } | null)?.id ?? null

        // Single-mode trades with a partial schedule fan their partials out
        // into `partial_tp_legs`. `partialTpMonitor` then polls /Quote and
        // /OrderCloses each slice as the live bid/ask crosses the trigger.
        // The LAST configured-bucket TP is the broker `takeprofit` so the
        // residual lot rides to the deepest target with no worker intervention.
        if (tradeRowId && leg.partialTps && leg.partialTps.length > 0) {
          const partialRows = leg.partialTps.map(p => ({
            trade_id: tradeRowId,
            signal_id: signal.id,
            user_id: signal.user_id,
            broker_account_id: broker.id,
            metaapi_account_id: uuid,
            symbol: args.symbol,
            is_buy: isBuy,
            tp_idx: p.tpIdx,
            trigger_price: p.triggerPrice,
            close_lots: p.closeLots,
            status: 'pending',
          }))
          const { error: partialErr } = await this.supabase
            .from('partial_tp_legs')
            .insert(partialRows)
          if (partialErr) {
            console.error(
              `[tradeExecutor] partial_tp_legs INSERT failed signal=${signal.id} broker=${broker.id} trade=${tradeRowId}: ${partialErr.message}`,
            )
          } else {
            console.log(
              `[tradeExecutor] partial_tp_legs inserted=${partialRows.length} signal=${signal.id} broker=${broker.id} trade=${tradeRowId}`
              + ` schedule=${leg.partialTps.map(p => `TP${p.tpIdx}@${p.triggerPrice}/${p.closeLots}`).join(',')}`,
            )
          }
        }

        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'order_send',
          status: 'success',
          request_payload: { ...args, ...orderLogContext } as unknown as Record<string, unknown>,
          response_payload: { ticket: result.ticket, latency_ms: latencyMs, leg: leg.idx + 1, total: totalCount },
        })
        return true
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
          request_payload: { ...args, ...orderLogContext } as unknown as Record<string, unknown>,
          error_message: msg,
        })
        return false
      }
    }

    // All immediates fan out in parallel. Virtual pendings are already
    // persisted; the worker monitor + edge sweep will fire them on trigger.
    const sendResults = await Promise.allSettled(legs.map(sendLeg))
    const anyImmediateOpened = sendResults.some(
      r => r.status === 'fulfilled' && r.value === true,
    )
    if (virtualPendings.length > 0 && !anyImmediateOpened && !strictDeferred) {
      const { error: stripErr } = await this.supabase
        .from('range_pending_legs')
        .delete()
        .eq('signal_id', signal.id)
        .eq('broker_account_id', broker.id)
      if (stripErr) {
        console.warn(
          `[tradeExecutor] strip orphan virtual pendings failed signal=${signal.id} broker=${broker.id}: ${stripErr.message}`,
        )
      } else {
        console.warn(
          `[tradeExecutor] stripped virtual pendings (zero successful immediates) signal=${signal.id} broker=${broker.id}`,
        )
      }
    }
    return { openedOrMerged: anyImmediateOpened || materializedVirtuals || strictBrokerPlaced }
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
    if (!hasMetatraderApiConfigured()) return
    if (!signal.parent_signal_id) return

    const brokerAccountIds = brokers.map(b => b.id)
    let symbolHint: string | null = parsed.symbol != null && String(parsed.symbol).trim()
      ? String(parsed.symbol).trim()
      : null
    try {
      const { data: ps } = await this.supabase
        .from('signals')
        .select('parsed_data')
        .eq('id', signal.parent_signal_id)
        .maybeSingle()
      const p = (ps as { parsed_data?: ParsedSignal | null } | null)?.parsed_data
      const fromParent = p?.symbol != null && String(p.symbol).trim() ? String(p.symbol).trim() : null
      if (fromParent) symbolHint = fromParent
    } catch {
      // best-effort
    }

    let basketAnchorId: string | null = signal.parent_signal_id
    const { count: parentOpenCount } = await this.supabase
      .from('trades')
      .select('id', { count: 'exact', head: true })
      .eq('signal_id', signal.parent_signal_id)
      .in('broker_account_id', brokerAccountIds)
      .eq('status', 'open')
    if ((parentOpenCount ?? 0) === 0) {
      const mgmtAction = String(parsed.action ?? '').toLowerCase()
      const mgmtDir = mgmtAction === 'buy' || mgmtAction === 'sell'
        ? mgmtAction
        : null
      const symForResolve = symbolHint?.trim() ?? ''
      if (mgmtDir && symForResolve && signal.channel_id && brokerAccountIds[0]) {
        const latest = await resolveLatestOpenBasketAnchor(this.supabase, {
          userId: signal.user_id,
          brokerAccountId: brokerAccountIds[0]!,
          brokerSymbol: symForResolve,
          signalSymbol: symForResolve,
          direction: mgmtDir,
          channelId: signal.channel_id,
        })
        if (latest) basketAnchorId = latest.anchorSignalId
      }
      if (!basketAnchorId || basketAnchorId === signal.parent_signal_id) {
        basketAnchorId = await this.resolveBasketAnchorSignalIdForOpenTrades({
          userId: signal.user_id,
          brokerAccountIds,
          channelId: signal.channel_id,
          parentSignalId: signal.parent_signal_id,
          symbolHint,
        })
      }
    }
    if (!basketAnchorId) {
      try {
        await this.supabase
          .from('signals')
          .update({ status: 'skipped', skip_reason: 'mgmt_no_parent_trades' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch { /* best-effort */ }
      return
    }

    type MgmtTradeRow = {
      id: string
      broker_account_id: string
      metaapi_order_id: string | null
      symbol: string
      direction: string
      lot_size: number
      status: string
      sl: number | null
      tp: number | null
      entry_price: number | null
    }

    const byBroker = new Map(brokers.map(b => [b.id, b]))
    const action = String(parsed.action).toLowerCase()
    const cancelledPendingScopes = new Set<string>()

    // Coerce a DB numeric to "what /OrderModify wants for this side".
    // null / NaN / 0 → 0 (no level on broker, same as current state).
    const sanitizeLevel = (v: number | null | undefined): number => {
      const n = typeof v === 'number' ? v : Number(v ?? 0)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    // A signal "contains" an SL / TP value only when the parser actually
    // populated it. parsed.sl = null and parsed.tp = null (or []) both mean
    // "the signal did not mention this side, leave it as-is". We never
    // infer "remove the level" from missing data — that requires an
    // explicit close/cancel action upstream.
    const hasNewSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
    const hasNewTp = Array.isArray(parsed.tp)
      && parsed.tp.length > 0
      && typeof parsed.tp[0] === 'number'
      && Number.isFinite(parsed.tp[0])
      && (parsed.tp[0] as number) > 0

    const mgmtCtx = { hasNewSl, hasNewTp }

    const loadOpenBasketTrades = async (): Promise<MgmtTradeRow[]> => {
      const { data } = await this.supabase
        .from('trades')
        .select('id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,status,sl,tp,entry_price')
        .eq('signal_id', basketAnchorId)
        .eq('status', 'open')
        .limit(500)
      return (data ?? []) as MgmtTradeRow[]
    }

    if (action === 'close_worse_entries') {
      const rows = await loadOpenBasketTrades()
      if (!rows.length) {
        try {
          await this.supabase
            .from('signals')
            .update({ status: 'skipped', skip_reason: 'mgmt_no_parent_trades' })
            .eq('id', signal.id)
            .eq('status', 'parsed')
        } catch { /* best-effort */ }
        return
      }
      const eligibleBrokers = brokers.filter(
        b => !isChannelManagementBlocked(
          normalizeChannelMessageFiltersMap(b.channel_message_filters),
          signal.channel_id,
          action,
          mgmtCtx,
        ),
      )
      if (!eligibleBrokers.length) {
        try {
          await this.supabase
            .from('signals')
            .update({ status: 'skipped', skip_reason: 'channel_filter_ignored' })
            .eq('id', signal.id)
            .eq('status', 'parsed')
        } catch { /* best-effort */ }
        return
      }
      const eligibleIds = new Set(eligibleBrokers.map(b => b.id))
      const eligibleRows = rows.filter(r => eligibleIds.has(r.broker_account_id))
      const eligibleByBroker = new Map(eligibleBrokers.map(b => [b.id, b]))
      await this.applyCloseWorseEntriesInstruction(signal, parsed, eligibleRows, eligibleByBroker)
      return
    }

    const rows = await loadOpenBasketTrades()
    if (!rows.length) {
      try {
        await this.supabase
          .from('signals')
          .update({ status: 'skipped', skip_reason: 'mgmt_no_parent_trades' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch { /* best-effort */ }
      return
    }

    await Promise.allSettled(rows.map(async trade => {
      const broker = byBroker.get(trade.broker_account_id)
      if (!broker || !isMtUuid(broker.metaapi_account_id)) return
      if (isChannelManagementBlocked(
        normalizeChannelMessageFiltersMap(broker.channel_message_filters),
        signal.channel_id,
        action,
        mgmtCtx,
      )) {
        return
      }
      const uuid = broker.metaapi_account_id!
      const ticket = Number(trade.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) return
      const api = this.apiFor(broker)
      if (!api) return

      try {
        if (action === 'close') {
          await api.orderClose(uuid, { ticket })
          await this.supabase.from('trades').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', trade.id)
          cancelledPendingScopes.add(JSON.stringify({
            signalId: basketAnchorId,
            brokerAccountId: trade.broker_account_id,
            symbol: trade.symbol,
          } satisfies RangePendingCancelScope))
        } else if (action === 'partial_profit' || action === 'partial_breakeven') {
          const fraction = typeof parsed.partial_close_fraction === 'number' && parsed.partial_close_fraction > 0
            ? Math.min(0.95, parsed.partial_close_fraction)
            : 0.5
          const lots = +(trade.lot_size * fraction).toFixed(2)
          await api.orderClose(uuid, { ticket, lots })
          const remaining = Math.max(0, +(trade.lot_size - lots).toFixed(2))
          if (remaining < 0.0001) {
            await this.supabase.from('trades').update({
              status: 'closed',
              closed_at: new Date().toISOString(),
              lot_size: 0,
            }).eq('id', trade.id)
          } else {
            await this.supabase.from('trades').update({ lot_size: remaining }).eq('id', trade.id)
          }
        } else if (action === 'breakeven') {
          const entry = sanitizeLevel(trade.entry_price)
          if (entry > 0) {
            await api.orderModify(uuid, {
              ticket,
              stoploss: entry,
              takeprofit: sanitizeLevel(trade.tp),
            })
            await this.supabase.from('trades').update({ sl: entry }).eq('id', trade.id)
          }
        } else if (action === 'modify') {
          const newSl = hasNewSl ? (parsed.sl as number) : sanitizeLevel(trade.sl)
          const newTp = hasNewTp ? (parsed.tp![0] as number) : sanitizeLevel(trade.tp)
          await api.orderModify(uuid, {
            ticket,
            stoploss: newSl,
            takeprofit: newTp,
          })
          const dbPatch: Record<string, number | null> = {}
          if (hasNewSl) dbPatch.sl = parsed.sl as number
          if (hasNewTp) dbPatch.tp = parsed.tp![0] as number
          if (Object.keys(dbPatch).length > 0) {
            await this.supabase.from('trades').update(dbPatch).eq('id', trade.id)
          }
        }
        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: `mgmt_${action}`,
          status: 'success',
          request_payload: {
            ticket,
            action,
            basket_anchor_signal_id: basketAnchorId,
            mgmt_parent_signal_id: signal.parent_signal_id,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: `mgmt_${action}`,
          status: 'failed',
          request_payload: {
            ticket,
            action,
            basket_anchor_signal_id: basketAnchorId,
            mgmt_parent_signal_id: signal.parent_signal_id,
          },
          error_message: msg,
        })
      }
    }))

    if (action === 'close' && cancelledPendingScopes.size > 0) {
      const scopes = Array.from(cancelledPendingScopes)
        .map(enc => JSON.parse(enc) as RangePendingCancelScope)
        .filter(scope => {
          const broker = byBroker.get(scope.brokerAccountId)
          if (!broker) return false
          return !isPendingCancelBlocked(
            normalizeChannelMessageFiltersMap(broker.channel_message_filters),
            signal.channel_id,
          )
        })
      if (scopes.length > 0) {
        await this.cancelRangePendingLegsForScopes(signal.user_id, signal.id, scopes, 'signal_closed')
      }
    }

    // Management messages do not insert `trades` with `signal_id = this row`,
    // so `sweep()` never skips them via the "trade already exists" guard.
    // Flip off `parsed` after one dispatch so we never double-apply the same
    // Close half / breakeven / modify intent on every 15s tick.
    try {
      const { error: sigErr } = await this.supabase
        .from('signals')
        .update({ status: 'executed' })
        .eq('id', signal.id)
        .eq('status', 'parsed')
      if (sigErr) {
        console.warn(`[tradeExecutor] mgmt signal finalize failed id=${signal.id}: ${sigErr.message}`)
      }
    } catch {
      // best-effort
    }
  }

  /**
   * Telegram "Close worse entries": close open basket legs whose entry is within
   * `close_worse_entries_pips` of the live quote at instruction time.
   */
  private async applyCloseWorseEntriesInstruction(
    signal: SignalRow,
    parsed: ParsedSignal,
    rows: Array<{
      id: string
      broker_account_id: string
      metaapi_order_id: string | null
      symbol: string
      direction: string
      lot_size: number
      status: string
      entry_price: number | null
    }>,
    byBroker: Map<string, BrokerRow>,
  ): Promise<void> {
    if (!hasMetatraderApiConfigured()) return

    const openRows = rows.filter(r => r.status === 'open')
    if (!openRows.length) {
      try {
        await this.supabase
          .from('signals')
          .update({ status: 'skipped', skip_reason: 'cwe_no_open_trades' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch { /* best-effort */ }
      return
    }

    const groups = new Map<string, typeof openRows>()
    for (const t of openRows) {
      const key = `${t.broker_account_id}|${t.symbol}`
      const list = groups.get(key) ?? []
      list.push(t)
      groups.set(key, list)
    }

    await Promise.allSettled(Array.from(groups.entries()).map(async ([key, groupTrades]) => {
      const [brokerId, symbol] = key.split('|')
      const broker = brokerId ? byBroker.get(brokerId) : undefined
      if (!broker || !isMtUuid(broker.metaapi_account_id)) return

      const manual = (broker.manual_settings ?? {}) as ManualSettings
      if (manual.trade_style !== 'multi' || manual.close_worse_entries !== true) {
        await this.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'mgmt_close_worse_entries',
          status: 'skipped',
          request_payload: {
            reason: 'close_worse_entries_disabled',
            trade_style: manual.trade_style ?? 'single',
          },
        })
        return
      }

      const pips = Math.max(1, Number(manual.close_worse_entries_pips ?? 30))
      const uuid = broker.metaapi_account_id!
      const api = this.apiFor(broker)
      if (!api) return
      const params = await this.getSymbolParams(uuid, symbol).catch(() => null)
      const pipQuote = pipCalculator(
        symbol,
        params?.point ?? 0.00001,
        params?.digits ?? 5,
        params?.contractSize ?? null,
      )
      const pipSize = pipQuote.pipPrice
      if (!Number.isFinite(pipSize) || pipSize <= 0) {
        console.warn(`[tradeExecutor] cwe instruction skip: invalid pip size symbol=${symbol}`)
        return
      }

      let q: { bid: number; ask: number }
      try {
        q = await api.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[tradeExecutor] cwe instruction /Quote failed symbol=${symbol}: ${msg}`)
        return
      }

      const direction = groupTrades[0]!.direction
      const ref = referencePriceForDirection(direction, q.bid, q.ask)
      const toClose = filterTradesWithinPipsOfReference({
        trades: groupTrades,
        referencePrice: ref,
        pips,
        pipSize,
      })

      console.log(
        `[tradeExecutor] cwe instruction signal=${signal.id} broker=${broker.id} symbol=${symbol}`
        + ` ref=${ref} pips=${pips} matched=${toClose.length}/${groupTrades.length}`,
      )

      for (const trade of toClose) {
        const ticket = Number(trade.metaapi_order_id)
        if (!Number.isFinite(ticket) || ticket <= 0) continue
        try {
          await api.orderClose(uuid, { ticket, lots: trade.lot_size })
          await this.supabase
            .from('trades')
            .update({
              status: 'closed',
              closed_at: new Date().toISOString(),
              cwe_close_price: null,
            })
            .eq('id', trade.id)
          await this.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'mgmt_close_worse_entries',
            status: 'success',
            request_payload: {
              ticket,
              symbol,
              direction: trade.direction,
              entry_price: trade.entry_price,
              reference_price: ref,
              pips,
              pip_size: pipSize,
            },
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg)
          if (benign) {
            await this.supabase
              .from('trades')
              .update({
                status: 'closed',
                closed_at: new Date().toISOString(),
                cwe_close_price: null,
              })
              .eq('id', trade.id)
          } else {
            await this.supabase.from('trade_execution_logs').insert({
              user_id: signal.user_id,
              signal_id: signal.id,
              broker_account_id: broker.id,
              action: 'mgmt_close_worse_entries',
              status: 'failed',
              request_payload: {
                ticket,
                symbol,
                entry_price: trade.entry_price,
                reference_price: ref,
                pips,
              },
              error_message: msg,
            })
          }
        }
      }
    }))

    try {
      const { error: sigErr } = await this.supabase
        .from('signals')
        .update({ status: 'executed' })
        .eq('id', signal.id)
        .eq('status', 'parsed')
      if (sigErr) {
        console.warn(`[tradeExecutor] cwe instruction finalize failed id=${signal.id}: ${sigErr.message}`)
      }
    } catch {
      // best-effort
    }
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
    if (!hasMetatraderApiConfigured()) return
    const brokers = Array.from(this.brokersById.values()).filter(b =>
      b.is_active && isMtUuid(b.metaapi_account_id),
    )
    if (!brokers.length) return
    console.log(`[tradeExecutor] legacy pending cleanup: scanning ${brokers.length} brokers...`)
    let totalClosed = 0
    let totalFailed = 0
    for (const broker of brokers) {
      const uuid = broker.metaapi_account_id!
      const api = this.apiFor(broker)
      if (!api) continue
      let orders: unknown[]
      try {
        orders = await api.openedOrders(uuid)
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
          await api.orderClose(uuid, { ticket })
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
    if (!hasMetatraderApiConfigured()) return null
    const api = this.apiForUuid(uuid)
    if (!api) return null
    try {
      const p: SymbolParams = await api.symbolParams(uuid, symbol)
      const n = normalizeSymbolParams(p)
      const entry: SymbolCacheEntry = {
        digits: n.digits ?? 5,
        point: n.point ?? 0.00001,
        minLot: n.minLot ?? 0.01,
        maxLot: n.maxLot ?? 100,
        lotStep: n.lotStep ?? 0.01,
        contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
        stopsLevel: Math.max(0, n.stopsLevel ?? 0),
        freezeLevel: Math.max(0, n.freezeLevel ?? 0),
        loadedAt: Date.now(),
      }
      // First-time-per-symbol diagnostic so we can confirm we actually see the
      // broker's stops/freeze levels (not silent zeros from a casing mismatch).
      console.log(`[tradeExecutor] symbol params loaded uuid=${uuid} symbol=${symbol} digits=${entry.digits} point=${entry.point} contractSize=${entry.contractSize ?? 'default'} stopsLevel=${entry.stopsLevel} freezeLevel=${entry.freezeLevel} minLot=${entry.minLot} lotStep=${entry.lotStep}`)
      this.symbolCache.set(key, entry)
      return entry
    } catch (e) {
      console.warn(`[tradeExecutor] /SymbolParams failed uuid=${uuid} symbol=${symbol}:`, e instanceof Error ? e.message : e)
      return null
    }
  }

  /** Load (and cache) the broker's full symbol list. Returns null if unavailable. */
  private async getSymbolList(uuid: string): Promise<SymbolListCacheEntry | null> {
    const cached = this.symbolListCache.get(uuid)
    if (cached && (Date.now() - cached.loadedAt) < SYMBOL_LIST_TTL_MS) return cached
    if (!hasMetatraderApiConfigured()) return null
    const api = this.apiForUuid(uuid)
    if (!api) return null
    try {
      const raw = await api.symbols(uuid)
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
