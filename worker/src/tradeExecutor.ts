import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import {
  getMetatraderApi,
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
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
  strictSignalEntryQuoteAllowsImmediate,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerPartialTp,
  type PlannerResult,
  type VirtualPendingLeg,
} from './manualPlanner'
import { isPostgresDuplicateKeyError } from './rangePendingLegPersist'
import { cancelSignalEntryRowAtBroker, type SignalEntryPendingRow } from './signalEntryPendingHelpers'
import {
  computeThreadLinksAnchor,
  implicitBundleTimeOk,
  isMergeFollowUpLinked,
  isWithinMergeSignalTimeWindow,
  MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
  mergeSignalTimeDeltaMs,
  parentSignalLinksAnchor,
} from './signalMergeLink'
import type { UserSessionManager } from './sessionManager'

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
  private api: MetatraderApiClient | null

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly sessionManager?: UserSessionManager,
  ) {
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
    if (!this.api) return
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
      if (this.api) {
        await cancelSignalEntryRowAtBroker(this.supabase, this.api, r, reason)
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
    if (!this.api) return
    const manual = (broker.manual_settings ?? {}) as ManualSettings
    if (manual.close_on_opposite_signal !== true) return
    const a = String(parsed.action ?? '').toLowerCase()
    if (a !== 'buy' && a !== 'sell') return
    const channelBuy = a === 'buy'
    const oppDir = channelBuy ? 'sell' : 'buy'
    const uuid = broker.metaapi_account_id!
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
        await this.api.orderClose(uuid, { ticket })
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
    if (scopes.length) {
      await this.cancelRangePendingLegsForScopes(signal.user_id, signal.id, scopes, 'opposite_signal_close')
    }
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
    if (!this.api) return { handled: false }
    const manual = (broker.manual_settings ?? {}) as ManualSettings
    if (manual.add_new_trades_to_existing !== true) return { handled: false }
    if (manual.use_signal_entry_price === true && !parsedHasExplicitEntryAnchor(parsed)) {
      return { handled: false }
    }

    const a = String(parsed.action ?? '').toLowerCase()
    if (a !== 'buy' && a !== 'sell') return { handled: false }
    const direction = a === 'buy' ? 'buy' : 'sell'

    // Realtime payloads may omit `created_at` / reply fields — load authoritative row for merge linking.
    let mergeSignal: SignalRow = signal
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
      if (row) {
        mergeSignal = {
          ...signal,
          created_at: signal.created_at ?? row.created_at,
          reply_to_message_id: signal.reply_to_message_id ?? row.reply_to_message_id ?? null,
          telegram_message_id: signal.telegram_message_id ?? row.telegram_message_id ?? null,
          parent_signal_id: signal.parent_signal_id ?? row.parent_signal_id ?? null,
          channel_id: signal.channel_id ?? row.channel_id ?? null,
        }
      }
    } catch {
      // best-effort; keep mergeSignal = signal
    }

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

    const { data: origSig } = await this.supabase
      .from('signals')
      .select('telegram_message_id, channel_id')
      .eq('id', anchorSignalId)
      .maybeSingle()
    const origTg = String(origSig?.telegram_message_id ?? '').trim()
    const anchorChannelId = String((origSig as { channel_id?: string | null } | null)?.channel_id ?? '').trim() || null
    const replyTo = String(mergeSignal.reply_to_message_id ?? '').trim()
    const replyOk = Boolean(replyTo && origTg && replyTo === origTg)

    const sigTime = mergeSignal.created_at ? new Date(mergeSignal.created_at).getTime() : Date.now()
    const tradeOpen = new Date(newest.opened_at).getTime()
    const dt = mergeSignalTimeDeltaMs({ signalCreatedAtMs: sigTime, newestTradeOpenedAtMs: tradeOpen })
    const withinWindow = isWithinMergeSignalTimeWindow(dt)
    const parentLinksAnchor = parentSignalLinksAnchor(mergeSignal.parent_signal_id, anchorSignalId)
    const hasReplyToTelegram = Boolean(replyTo)
    let ancestorChainContainsAnchor = false
    if (hasReplyToTelegram && !parentLinksAnchor) {
      ancestorChainContainsAnchor = await this.parentSignalIdChainContainsAnchor(
        mergeSignal.parent_signal_id,
        anchorSignalId,
      )
    }
    const threadLinksAnchor = computeThreadLinksAnchor({
      parentLinksAnchor,
      hasReplyToTelegram,
      ancestorChainContainsAnchor,
    })
    const mergeCh = String(mergeSignal.channel_id ?? '').trim() || null
    const implicitBundleWithinTightWindow = implicitBundleTimeOk(dt, MERGE_IMPLICIT_CHANNEL_BUNDLE_MS)
    const implicitSameChannelBundle = Boolean(
      mergeCh &&
        anchorChannelId &&
        mergeCh === anchorChannelId &&
        !replyOk &&
        !threadLinksAnchor,
    )
    if (!isMergeFollowUpLinked({
      replyOk,
      withinWindow,
      threadLinksAnchor,
      implicitBundleWithinTightWindow,
      implicitSameChannelBundle,
    })) {
      return { handled: false }
    }

    // Planner / predefined SL-TP need an entry anchor. Re-use the live trade's fill when the new parse has none.
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
      if (Number.isFinite(ep) && ep > 0) {
        plannerParsed.entry_price = ep
      }
    }
    if (!parsedHasExplicitEntryAnchor(plannerParsed)) {
      try {
        const q = strictEntryPrefetch ?? await this.api.quote(uuid, symbol)
        plannerParsed.entry_price = direction === 'buy' ? q.ask : q.bid
      } catch {
        console.warn(`[tradeExecutor] merge skipped: no entry anchor signal=${signal.id} symbol=${symbol}`)
        return { handled: false }
      }
    }

    // Full manual (multi + range + tp_lots %) so each immediate leg maps to the correct bucket TP.
    const mergeBaseOp: MtOperation =
      op === 'Buy' || op === 'Sell' ? op : direction === 'buy' ? 'Buy' : 'Sell'

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

    if (plan.skip_reason || plan.orders.length === 0) return { handled: false }

    const marketOrders = plan.orders.filter(o => o.operation === 'Buy' || o.operation === 'Sell')
    if (!marketOrders.length) return { handled: false }

    let virtualPendings = (plan.virtualPendings ?? []).slice(0, 500)

    if (plan.delay_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(plan.delay_ms, 30_000)))
    }

    // Same strict-entry live quote rule as `sendOrder`: merge refresh only when the
    // market is already at or better than the signal entry (no virtual deferral here).
    if (manual.use_signal_entry_price === true && plan.strictEntry && this.api) {
      const se = plan.strictEntry
      try {
        const q = strictEntryPrefetch ?? await this.api.quote(uuid, symbol)
        const immediateOk = strictSignalEntryQuoteAllowsImmediate({
          isBuy: se.isBuy,
          entryPrice: se.entryPrice,
          bid: q.bid,
          ask: q.ask,
        })
        if (!immediateOk) return { handled: false }
      } catch {
        return { handled: false }
      }
    }

    // Per-leg SL/TP (and optional CWE) aligned with `planManualOrders` immediate sequence.
    const immediateArgs = marketOrders.map(o => ({ ...o }))
    const needsAnchor = virtualPendings.length > 0 || !!plan.closeWorseEntries
    let anchor: number | null = plan.anchor?.value ?? null
    let anchorSource: 'signal' | 'quote' | 'unknown' = plan.anchor?.source ?? 'unknown'
    if (needsAnchor && (anchor == null || anchor <= 0) && this.api) {
      try {
        const q = strictEntryPrefetch ?? await this.api.quote(uuid, symbol)
        anchor = plan.isBuy === false ? q.bid : q.ask
        anchorSource = 'quote'
      } catch {
        // anchor may stay null; virtual insert path will drop legs
      }
    }
    const overrideTp = computeCweTp(plan, anchor, params)
    let nImmCwe = 0
    if (overrideTp != null && plan.closeWorseEntries) {
      nImmCwe = Math.max(0, Math.min(immediateArgs.length, plan.closeWorseEntries.immediates))
      for (let i = 0; i < nImmCwe; i++) {
        immediateArgs[i] = {
          ...immediateArgs[i]!,
          takeprofit: 0,
          comment: `${immediateArgs[i]!.comment ?? ''}.cw`,
        }
      }
      const nVirt = Math.max(0, Math.min(virtualPendings.length, plan.closeWorseEntries.extraPendings))
      for (let i = 0; i < nVirt; i++) {
        virtualPendings[i] = {
          ...virtualPendings[i]!,
          takeprofit: null,
          comment: `${virtualPendings[i]!.comment}.cw`,
          cweClosePrice: overrideTp,
        }
      }
    }

    const legPairs = Math.min(immediateArgs.length, familyTrades.length)
    if (legPairs < immediateArgs.length || legPairs < familyTrades.length) {
      console.warn(
        `[tradeExecutor] merge leg mismatch signal=${signal.id} broker=${broker.id} symbol=${symbol}`
        + ` plan_immediate=${immediateArgs.length} open_same_family=${familyTrades.length} applying_first=${legPairs}`,
      )
    }

    await this.cancelRangePendingLegsForScopes(signal.user_id, signal.id, [{
      signalId: anchorSignalId,
      brokerAccountId: broker.id,
      symbol,
    }], 'signal_merge_refresh')

    for (const t of familyTrades) {
      try {
        await this.supabase.from('partial_tp_legs').delete().eq('trade_id', t.id)
      } catch {
        // best-effort
      }
    }

    let mergeFailed = false
    for (let i = 0; i < legPairs; i++) {
      const tr = familyTrades[i]!
      const ord = immediateArgs[i]!
      const ticket = Number(tr.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) {
        mergeFailed = true
        continue
      }
      let ref = Number(tr.entry_price) || 0
      if (ref <= 0) {
        try {
          const q = strictEntryPrefetch ?? await this.api.quote(uuid, symbol)
          ref = direction === 'buy' ? q.ask : q.bid
        } catch {
          mergeFailed = true
          continue
        }
      }
      if (!Number.isFinite(ref) || ref <= 0) {
        mergeFailed = true
        continue
      }
      const vol = roundLot(Number(tr.lot_size) || ord.volume || baseLot, params)
      const sendShape: OrderSendArgs = {
        symbol,
        operation: direction === 'buy' ? 'Buy' : 'Sell',
        volume: vol,
        price: ref,
        stoploss: ord.stoploss ?? 0,
        takeprofit: ord.takeprofit ?? 0,
        slippage: ord.slippage ?? 20,
        comment: ord.comment,
        expertID: ord.expertID,
      }
      const clamped = clampOrderStops(sendShape, params)
      if (clamped.adjustments.length > 0) {
        console.warn(
          `[tradeExecutor] merge modify stops clamped signal=${signal.id} broker=${broker.id} leg=${i + 1}/${legPairs} symbol=${symbol}: ${clamped.adjustments.join(', ')}`,
        )
      }
      try {
        const modRes = await this.api.orderModify(uuid, {
          ticket,
          stoploss: clamped.args.stoploss ?? 0,
          takeprofit: clamped.args.takeprofit ?? 0,
        })
        const newSl = modRes.stopLoss ?? clamped.args.stoploss ?? null
        const newTp = modRes.takeProfit ?? clamped.args.takeprofit ?? null
        const cweClose = i < nImmCwe ? overrideTp : null
        await this.supabase.from('trades').update({
          sl: typeof newSl === 'number' && newSl > 0 ? newSl : null,
          tp: typeof newTp === 'number' && newTp > 0 ? newTp : null,
          cwe_close_price: typeof cweClose === 'number' && cweClose > 0 ? cweClose : null,
        }).eq('id', tr.id)
      } catch (err) {
        mergeFailed = true
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[tradeExecutor] merge OrderModify failed leg=${i + 1} trade=${tr.id} ticket=${ticket}: ${msg}`)
      }
    }

    if (virtualPendings.length > 0) {
      if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) {
        console.warn(
          `[tradeExecutor] merge dropping ${virtualPendings.length} virtual pendings: no anchor signal=${signal.id} broker=${broker.id} symbol=${symbol}`,
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
          if (zoneHi != null && zoneLo != null && triggerPrice > zoneLo && triggerPrice < zoneHi) {
            console.warn(
              `[tradeExecutor] merge dropped virtual pending stepIdx=${v.stepIdx} trigger=${triggerPrice} inside stops zone`,
            )
            continue
          }
          const expiresAt = v.expiryHours && v.expiryHours > 0
            ? new Date(nowMs + v.expiryHours * 60 * 60 * 1000).toISOString()
            : null
          insertRows.push({
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
          })
        }
        if (insertRows.length > 0) {
          const persist = await this.persistRangePendingLegRows(
            insertRows,
            `merge signal=${signal.id} anchor=${anchorSignalId}`,
          )
          if (!persist.ok) {
            console.error(
              `[tradeExecutor] merge range_pending_legs persist failed signal=${signal.id}: ${persist.lastError ?? 'unknown'}`,
            )
            mergeFailed = true
          } else {
            console.log(
              `[tradeExecutor] merge virtual pendings inserted=${insertRows.length} parent_signal=${anchorSignalId} merge_signal=${signal.id}`,
            )
          }
        }
      }
    }

    if (plan.partialTps?.length && familyTrades.length === 1 && legPairs === 1) {
      const tr0 = familyTrades[0]!
      const isBuy = direction === 'buy'
      const partialRows = plan.partialTps.map(p => ({
        trade_id: tr0.id,
        signal_id: tr0.signal_id,
        user_id: signal.user_id,
        broker_account_id: broker.id,
        metaapi_account_id: uuid,
        symbol,
        is_buy: isBuy,
        tp_idx: p.tpIdx,
        trigger_price: p.triggerPrice,
        close_lots: p.closeLots,
        status: 'pending',
      }))
      const { error: partialErr } = await this.supabase.from('partial_tp_legs').insert(partialRows)
      if (partialErr) {
        console.warn(`[tradeExecutor] merge partial_tp_legs INSERT failed: ${partialErr.message}`)
      }
    }

    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'signal_merge_into_open_trade',
        status: mergeFailed ? 'failed' : 'success',
        request_payload: {
          parent_signal_id: anchorSignalId,
          symbol,
          legs_updated: legPairs,
          plan_immediate_legs: immediateArgs.length,
          open_family_legs: familyTrades.length,
          virtual_pendings: virtualPendings.length,
          reply_chain: replyOk,
          within_time_window: withinWindow,
          parent_links_anchor: parentLinksAnchor,
          has_reply_to_telegram: hasReplyToTelegram,
          ancestor_chain_contains_anchor: ancestorChainContainsAnchor,
          thread_links_anchor: threadLinksAnchor,
          implicit_bundle_within_tight_window: implicitBundleWithinTightWindow,
          implicit_same_channel_bundle: implicitSameChannelBundle,
          implicit_bundle_dt_ms: dt,
          merge_implicit_tight_window_ms: MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
        } as unknown as Record<string, unknown>,
      })
    } catch {
      // best-effort
    }

    if (!mergeFailed) {
      try {
        await this.supabase
          .from('signals')
          .update({ status: 'executed' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch {
        // best-effort
      }
    }
    return { handled: true, success: !mergeFailed }
  }

  private async sweepExpiredTscopierBrokerPendings(): Promise<void> {
    if (!this.api) return
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
      let orders: unknown[]
      try {
        orders = await this.api.openedOrders(uuid)
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
          await this.api.orderClose(uuid, { ticket })
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
    if (!this.api) return {}
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
        return {}
      }
    }

    const requestedSymbol = mapping.symbol
    if (isExcluded(requestedSymbol, broker)) return {}

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
    if (
      this.api
      && isManual
      && manual.use_signal_entry_price === true
      && parsedHasExplicitEntryAnchor(parsed)
    ) {
      try {
        strictEntryPrefetch = await this.api.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[tradeExecutor] /Quote prefetch failed (signal entry strictness) ${symbol} signal=${signal.id} broker=${broker.id}: ${msg}`,
        )
      }
    }

    if (isManual && manual.close_on_opposite_signal === true) {
      await this.closeOppositeDirectionTrades(signal, parsed, broker, symbol)
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
      if (mergeOutcome.handled) {
        return { openedOrMerged: mergeOutcome.success }
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
    if (isManual && plan.strictEntry && this.api) {
      const se = plan.strictEntry
      try {
        const q = await this.api.quote(uuid, symbol)
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
    if (needsAnchor && (anchor == null || anchor <= 0) && this.api) {
      try {
        const q = strictEntryPrefetch ?? await this.api.quote(uuid, symbol)
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

    // Apply Close-Worse-Entries to the first N immediates + first N shallowest
    // virtual pendings. As of May-12 this is a *worker-managed* close: the
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
      const nVirt = Math.max(0, Math.min(virtualPendings.length, plan.closeWorseEntries.extraPendings))
      // Virtuals are already ordered by stepIdx ascending (shallowest first).
      for (let i = 0; i < nVirt; i++) {
        virtualPendings[i] = {
          ...virtualPendings[i]!,
          takeprofit: null,
          comment: `${virtualPendings[i]!.comment}.cw`,
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
    if (strictDeferred && plan.strictEntry && capped.length > 0 && this.api) {
      const se = plan.strictEntry
      const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
      const entryPx = Number(se.entryPrice.toFixed(digits))
      const anchorForRow =
        anchor != null && Number.isFinite(anchor) && anchor > 0 ? Number(anchor.toFixed(digits)) : entryPx
      const pendHours = clampPendingExpiryHours(manual.pending_expiry_hours)
      const nowMs = Date.now()
      const expiresAt = pendHours > 0
        ? new Date(nowMs + pendHours * 60 * 60 * 1000).toISOString()
        : null
      const point = Number(params?.point ?? 0)
      const safe = Math.max(Number(params?.stopsLevel) || 0, Number(params?.freezeLevel) || 0)
      const zoneHi = safe > 0 && point > 0 ? anchorForRow + (safe + 2) * point : null
      const zoneLo = safe > 0 && point > 0 ? anchorForRow - (safe + 2) * point : null
      if (zoneHi != null && zoneLo != null && entryPx > zoneLo && entryPx < zoneHi) {
        console.warn(
          `[tradeExecutor] strict entry inside stops zone; skipping broker pending signal=${signal.id} broker=${broker.id} symbol=${symbol} entry=${entryPx}`,
        )
      } else {
        const op: MtOperation = se.isBuy ? 'BuyLimit' : 'SellLimit'
        const first = capped[0]!
        let aggVol = 0
        for (const o of capped) aggVol += Number(o.volume) || 0
        const vol = roundLot(capped.length === 1 ? Number(first.volume) || 0 : aggVol, params)
        const baseComment = first.comment ?? `TSCopier:${signal.id.slice(0, 8)}`
        const comment = capped.length === 1 ? `${baseComment}:strictEntry` : `${baseComment}:strictEntryAgg`
        // Do not pass `expiration` / `expirationType` to MetatraderAPI OrderSend here:
        // several MT5 builds return "Invalid order expiration date" for ISO strings
        // on GET /OrderSend. `expires_at` is still stored on `signal_entry_pending_orders`
        // and the worker monitor closes the broker pending when that time is reached.
        const sendArgs: OrderSendArgs = {
          symbol,
          operation: op,
          volume: vol,
          price: entryPx,
          stoploss: first.stoploss ?? 0,
          takeprofit: first.takeprofit ?? 0,
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
          const result = await this.api.orderSend(uuid, clamped.args)
          const ticket = result.ticket
          const isBuyLeg = se.isBuy
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
              sl: clamped.args.stoploss && clamped.args.stoploss > 0 ? clamped.args.stoploss : null,
              tp: clamped.args.takeprofit && clamped.args.takeprofit > 0 ? clamped.args.takeprofit : null,
              lot_size: result.lots ?? vol,
              status: 'pending',
              opened_at: new Date().toISOString(),
              cwe_close_price: null,
            })
            .select('id')
            .maybeSingle()
          if (tradeInsert.error) {
            console.error(
              `[tradeExecutor] trades INSERT failed after strict pending OrderSend signal=${signal.id} broker=${broker.id} ticket=${ticket}: ${tradeInsert.error.message}`,
            )
            try {
              await this.api.orderClose(uuid, { ticket })
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
                await this.api.orderClose(uuid, { ticket })
              } catch {
                /* best-effort rollback */
              }
            } else {
              const partialTpPlan = capped.length === 1 && plan.partialTps?.length ? plan.partialTps : null
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
                await this.api.orderClose(uuid, { ticket })
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
        const result = await this.api!.orderSend(uuid, args)
        const latencyMs = Date.now() - t0
        console.log(
          `[tradeExecutor] OrderSend ok signal=${signal.id} broker=${broker.id} ticket=${result.ticket} leg=${leg.idx + 1}/${totalCount} price=${args.price ?? 0} ${latencyMs}ms`,
        )

        const isBuy = !args.operation.toLowerCase().includes('sell')
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
            entry_price: result.openPrice ?? args.price ?? null,
            sl: result.stopLoss ?? args.stoploss ?? null,
            tp: result.takeProfit ?? args.takeprofit ?? null,
            lot_size: result.lots ?? args.volume,
            status: args.operation.includes('Limit') || args.operation.includes('Stop') ? 'pending' : 'open',
            opened_at: new Date().toISOString(),
            // Worker-managed Close-Worse-Entries threshold (see cweCloseMonitor).
            // Only the first N immediate legs have this; non-CWE legs leave it null
            // and ride their bucket TP / SL normally.
            cwe_close_price: leg.cweClosePrice ?? null,
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
          request_payload: args as unknown as Record<string, unknown>,
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
          request_payload: args as unknown as Record<string, unknown>,
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
    if (!this.api) return
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

    const basketAnchorId = await this.resolveBasketAnchorSignalIdForOpenTrades({
      userId: signal.user_id,
      brokerAccountIds,
      channelId: signal.channel_id,
      parentSignalId: signal.parent_signal_id,
      symbolHint,
    })
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

    // Pull the existing sl/tp/entry_price so a one-sided management command
    // ("Adjust SL to 4500") can preserve the OTHER side. MetatraderAPI's
    // /OrderModify treats stoploss=0 / takeprofit=0 as "remove the level",
    // and our client always serializes both fields — so without these
    // saved values an SL-only modify silently wipes the TP, and a
    // breakeven move silently wipes the TP too.
    const { data: trades } = await this.supabase
      .from('trades')
      .select('id,broker_account_id,metaapi_order_id,symbol,lot_size,status,sl,tp,entry_price')
      .eq('signal_id', basketAnchorId)
    const rows = (trades ?? []) as {
      id: string
      broker_account_id: string
      metaapi_order_id: string | null
      symbol: string
      lot_size: number
      status: string
      sl: number | null
      tp: number | null
      entry_price: number | null
    }[]
    if (!rows.length) {
      // Child management rows never get `trades.signal_id = child.id`, so the
      // periodic sweep cannot distinguish "already applied" from "never run".
      // Without flipping status off `parsed`, the same "Close half" message is
      // re-processed every 15s (and on every realtime UPDATE), applying the
      // partial over and over until the position is flat.
      try {
        await this.supabase
          .from('signals')
          .update({ status: 'skipped', skip_reason: 'mgmt_no_parent_trades' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch { /* best-effort */ }
      return
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
          await this.api!.orderClose(uuid, { ticket, lots })
          // Keep the row aligned with what we asked the broker to close so any
          // future management math (or a delayed retry) does not re-use the
          // pre-partial lot size.
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
            // Preserve the existing TP. Without this, breakeven silently
            // wiped the take-profit because /OrderModify's takeprofit
            // defaults to 0.
            await this.api!.orderModify(uuid, {
              ticket,
              stoploss: entry,
              takeprofit: sanitizeLevel(trade.tp),
            })
            await this.supabase.from('trades').update({ sl: entry }).eq('id', trade.id)
          }
        } else if (action === 'modify') {
          // Use the signal's value when it spelled one out, otherwise carry
          // the trade row's persisted level through. This is what lets
          // "Adjust SL to 4500" keep the existing TP intact (and vice versa).
          const newSl = hasNewSl ? (parsed.sl as number) : sanitizeLevel(trade.sl)
          const newTp = hasNewTp ? (parsed.tp![0] as number) : sanitizeLevel(trade.tp)
          await this.api!.orderModify(uuid, {
            ticket,
            stoploss: newSl,
            takeprofit: newTp,
          })
          // Only persist the columns we actually changed. Skipping the
          // unchanged side keeps the row honest if the broker rejects one
          // but accepts the other (which we'd hear about via the catch).
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
      const scopes = Array.from(cancelledPendingScopes).map(
        enc => JSON.parse(enc) as RangePendingCancelScope,
      )
      await this.cancelRangePendingLegsForScopes(signal.user_id, signal.id, scopes, 'signal_closed')
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
