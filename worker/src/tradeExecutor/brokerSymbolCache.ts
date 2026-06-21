import type { TradeExecutorContext } from './context'
import type { ParsedSignal } from './types'
import {
  hasFxsocketConfigured,
  FxsocketBrokerClient,
  isApiThrottleError,
  normalizeSymbolParams,
  parseApiThrottleBackoffMs,
  type SymbolParams,
} from '../fxsocketClient'
import type { ManualSettings } from '../manualPlanner'
import { writeBrokerConnectionStatus } from '../brokerConnectionStatus'
import { replayParsedSignalsForBroker } from '../brokerSignalReplay'
import { applySymbolMapping, brokerSessionUuid, isMtUuid, parseSymbolToTradeList } from './helpers'
import {
  SESSION_PING_MIN_INTERVAL_MS,
  SYMBOL_CACHE_STALE_MS,
  SYMBOL_CACHE_TTL_MS,
  SYMBOL_LIST_TTL_MS,
  type BrokerRow,
  type SignalRow,
  type SymbolCacheEntry,
  type SymbolListCacheEntry,
} from './types'

const HEARTBEAT_FAILURES_BEFORE_DOWN = Math.max(
  2,
  Number(process.env.BROKER_HEARTBEAT_FAILURES_BEFORE_DOWN ?? 4) || 4,
)
const HEARTBEAT_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.BROKER_HEARTBEAT_CONCURRENCY ?? 2) || 2),
)
const HEARTBEAT_BATCH_GAP_MS = Math.max(
  0,
  Math.min(2000, Number(process.env.BROKER_HEARTBEAT_BATCH_GAP_MS ?? 250) || 250),
)
const SYMBOL_KEEPALIVE_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.SYMBOL_KEEPALIVE_CONCURRENCY ?? 2) || 2),
)
const heartbeatFailCounts = new Map<string, number>()

function activeBrokersForHeartbeat(ctx: TradeExecutorContext): BrokerRow[] {
  return [...ctx.brokersById.values()].filter(b => b.is_active && brokerSessionUuid(b))
}

export function collectPrewarmSymbolsForBroker(broker: BrokerRow): string[] {
  const manual = (broker.manual_settings ?? {}) as { symbol_to_trade?: string | null }
  const symbols = parseSymbolToTradeList(manual.symbol_to_trade)
  const base = symbols.length > 0 ? symbols : ['XAUUSD', 'EURUSD']
  const out = new Set<string>()
  for (const sym of base) {
    out.add(sym)
    out.add(applySymbolMapping(sym, broker).symbol)
  }
  return [...out]
}

function prewarmBrokerSymbolCaches(ctx: TradeExecutorContext, broker: BrokerRow): void {
  const uuid = brokerSessionUuid(broker)
  if (!uuid) return
  void ctx.getSymbolList(uuid).catch(() => null)
  for (const sym of collectPrewarmSymbolsForBroker(broker)) {
    void ctx.getSymbolParams(uuid, sym).catch(() => null)
  }
}

async function pingBrokerSessionInner(
  ctx: TradeExecutorContext,
  broker: BrokerRow,
  api: FxsocketBrokerClient,
  uuid: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  const now = Date.now()
  const last = ctx.sessionPingAt.get(uuid) ?? 0
  if (!opts?.force && now - last < SESSION_PING_MIN_INTERVAL_MS) return true
  if (ctx.sessionCheckInflight.has(uuid)) return false

  const wasBlocked = ctx.sessionOrderBlocked.has(broker.id)
  try {
    const alive = await api.keepSessionAlive(uuid)
    if (alive) {
      heartbeatFailCounts.delete(uuid)
      ctx.sessionPingAt.set(uuid, Date.now())
      if (wasBlocked) {
        ctx.sessionOrderBlocked.delete(broker.id)
        void replayParsedSignalsForBroker(ctx, broker)
      }
      return true
    }
  } catch (err) {
    if (isApiThrottleError(err)) {
      const backoff = parseApiThrottleBackoffMs(err)
      ctx.sessionPingAt.set(uuid, Date.now())
      console.warn(
        `[tradeExecutor] keepSessionAlive throttled broker=${broker.id} uuid=${uuid}; backoff ${backoff}ms`,
      )
      return true
    }
    /* fall through to failure count */
  }

  const fails = (heartbeatFailCounts.get(uuid) ?? 0) + 1
  heartbeatFailCounts.set(uuid, fails)
  if (fails >= HEARTBEAT_FAILURES_BEFORE_DOWN) {
    heartbeatFailCounts.delete(uuid)
    await ctx.markBrokerSessionDown(broker, uuid, 'heartbeat keepSessionAlive failed')
  }
  return false
}

export function prewarmSymbolsEnabled(ctx: TradeExecutorContext, ): boolean {
    const v = String(process.env.EXECUTOR_PREWARM_SYMBOLS ?? 'true').toLowerCase()
    return v !== '0' && v !== 'false' && v !== 'no'
  }

export async function prewarmBrokerCaches(ctx: TradeExecutorContext, ): Promise<void> {
    if (!ctx.prewarmSymbolsEnabled() || !hasFxsocketConfigured()) return
    for (const row of ctx.brokersById.values()) {
      const uuid = brokerSessionUuid(row)
      if (!uuid) continue
      prewarmBrokerSymbolCaches(ctx, row)
    }
  }

export async function sessionHeartbeatTick(ctx: TradeExecutorContext): Promise<void> {
  if (!hasFxsocketConfigured()) return
  const brokers = activeBrokersForHeartbeat(ctx)
  if (!brokers.length) return

  for (let i = 0; i < brokers.length; i += HEARTBEAT_CONCURRENCY) {
    if (i > 0 && HEARTBEAT_BATCH_GAP_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, HEARTBEAT_BATCH_GAP_MS))
    }
    const batch = brokers.slice(i, i + HEARTBEAT_CONCURRENCY)
    await Promise.all(batch.map(async broker => {
      const uuid = brokerSessionUuid(broker)
      if (!uuid) return
      const api = ctx.apiFor(broker)
      if (!api) return
      await pingBrokerSessionInner(ctx, broker, api, uuid)
    }))
  }
}

export async function reconnectCachedBrokers(_ctx: TradeExecutorContext): Promise<void> {
  /* FxSocket manages terminal lifecycle */
}

export async function pingBrokerSession(ctx: TradeExecutorContext, row: BrokerRow): Promise<void> {
  if (!hasFxsocketConfigured() || !row.is_active) return
  const uuid = brokerSessionUuid(row)
  if (!uuid) return
  const api = ctx.apiFor(row)
  if (!api) return
  await pingBrokerSessionInner(ctx, row, api, uuid, { force: true })
}

export async function symbolCacheKeepaliveTick(ctx: TradeExecutorContext, ): Promise<void> {
    if (!hasFxsocketConfigured()) return
    if (!ctx.prewarmSymbolsEnabled()) return

    const uuidsWithList = [...ctx.symbolListCache.keys()]
    for (let i = 0; i < uuidsWithList.length; i += SYMBOL_KEEPALIVE_CONCURRENCY) {
      const batch = uuidsWithList.slice(i, i + SYMBOL_KEEPALIVE_CONCURRENCY)
      await Promise.all(batch.map(async uuid => {
        try {
          const fresh = await ctx.fetchSymbolList(uuid)
          if (fresh) ctx.symbolListCache.set(uuid, fresh)
        } catch { /* best-effort */ }
      }))
      if (i + SYMBOL_KEEPALIVE_CONCURRENCY < uuidsWithList.length && HEARTBEAT_BATCH_GAP_MS > 0) {
        await new Promise(resolve => setTimeout(resolve, HEARTBEAT_BATCH_GAP_MS))
      }
    }

    const paramsKeys = [...ctx.symbolCache.keys()]
    for (let i = 0; i < paramsKeys.length; i += SYMBOL_KEEPALIVE_CONCURRENCY) {
      const batch = paramsKeys.slice(i, i + SYMBOL_KEEPALIVE_CONCURRENCY)
      await Promise.all(batch.map(async key => {
        const sepIdx = key.indexOf(':')
        if (sepIdx < 0) return
        const uuid = key.slice(0, sepIdx)
        const symbol = key.slice(sepIdx + 1)
        if (!isMtUuid(uuid) || !symbol) return
        const api = ctx.apiForUuid(uuid)
        if (!api) return
        try {
          const p: SymbolParams = await api.symbolParams(uuid, symbol)
          const n = normalizeSymbolParams(p)
          ctx.symbolCache.set(key, {
            digits: n.digits ?? 5,
            point: n.point ?? 0.00001,
            minLot: n.minLot ?? 0.01,
            maxLot: n.maxLot ?? 100,
            lotStep: n.lotStep ?? 0.01,
            contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
            stopsLevel: Math.max(0, n.stopsLevel ?? 0),
            freezeLevel: Math.max(0, n.freezeLevel ?? 0),
            loadedAt: Date.now(),
          })
        } catch { /* best-effort */ }
      }))
      if (i + SYMBOL_KEEPALIVE_CONCURRENCY < paramsKeys.length && HEARTBEAT_BATCH_GAP_MS > 0) {
        await new Promise(resolve => setTimeout(resolve, HEARTBEAT_BATCH_GAP_MS))
      }
    }
  }

export async function markBrokerSessionDown(ctx: TradeExecutorContext, broker: BrokerRow, uuid: string, reason: string): Promise<void> {
    ctx.sessionPingAt.delete(uuid)
    ctx.sessionOrderBlocked.add(broker.id)
    console.warn(`[tradeExecutor] broker ${broker.id} session down: ${reason}`)
    broker.connection_status = 'error'
    await writeBrokerConnectionStatus(ctx.supabase, broker.id, 'error', { rawError: reason })
  }

export async function ensureBrokerSession(ctx: TradeExecutorContext,
    api: FxsocketBrokerClient,
    uuid: string,
    broker: BrokerRow,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    const now = Date.now()
    const last = ctx.sessionPingAt.get(uuid) ?? 0
    const blocked = ctx.sessionOrderBlocked.has(broker.id)
    if (!opts?.force && !blocked && now - last < SESSION_PING_MIN_INTERVAL_MS) return true
    const ready = await api.verifyTradingReady(uuid)
    if (ready) {
      ctx.sessionPingAt.set(uuid, now)
      if (blocked) void replayParsedSignalsForBroker(ctx, broker)
      ctx.sessionOrderBlocked.delete(broker.id)
      return true
    }
    await ctx.markBrokerSessionDown(
      broker,
      uuid,
      blocked
        ? 'session blocked after prior OrderSend disconnect'
        : 'verifyTradingReady failed before OrderSend',
    )
    return false
  }

export async function ensureBrokerSessionLiveFast(ctx: TradeExecutorContext, 
    api: FxsocketBrokerClient,
    uuid: string,
    broker: BrokerRow,
  ): Promise<boolean> {
    const now = Date.now()
    const last = ctx.sessionPingAt.get(uuid) ?? 0
    const blocked = ctx.sessionOrderBlocked.has(broker.id)
    if (!blocked && now - last < SESSION_PING_MIN_INTERVAL_MS) return true

    const inflight = ctx.sessionCheckInflight.get(uuid)
    if (inflight) return inflight

    const check = (async () => {
      try {
        const alive = await api.keepSessionAlive(uuid)
        if (alive) {
          ctx.sessionPingAt.set(uuid, Date.now())
          if (blocked) void replayParsedSignalsForBroker(ctx, broker)
          ctx.sessionOrderBlocked.delete(broker.id)
          return true
        }
        await ctx.markBrokerSessionDown(
          broker,
          uuid,
          blocked
            ? 'session blocked after prior OrderSend disconnect'
            : 'keepSessionAlive failed before live OrderSend',
        )
        return false
      } finally {
        ctx.sessionCheckInflight.delete(uuid)
      }
    })()
    ctx.sessionCheckInflight.set(uuid, check)
    return check
  }

export function brokersWarmForLiveEntry(ctx: TradeExecutorContext, brokers: BrokerRow[], signalSymbol: string): boolean {
    if (!brokers.length) return true
    const now = Date.now()
    for (const broker of brokers) {
      const uuid = brokerSessionUuid(broker)
      if (!uuid) continue
      if (ctx.sessionOrderBlocked.has(broker.id)) return false
      const lastPing = ctx.sessionPingAt.get(uuid) ?? 0
      if (now - lastPing >= SESSION_PING_MIN_INTERVAL_MS) return false
      const symbolList = ctx.symbolListCache.get(uuid)
      if (!symbolList || now - symbolList.loadedAt >= SYMBOL_LIST_TTL_MS) return false
      const mapping = applySymbolMapping(signalSymbol, broker)
      const requested = mapping.symbol
      const key = `${uuid}:${requested.toUpperCase()}`
      const params = ctx.symbolCache.get(key)
      if (!params || now - params.loadedAt >= SYMBOL_CACHE_TTL_MS) return false
    }
    return true
  }

export function prewarmForDispatch(ctx: TradeExecutorContext, row: SignalRow): void {
    if (!hasFxsocketConfigured()) return
    const parsed = row.parsed_data as ParsedSignal | null
    const signalSymbol = parsed?.symbol
    if (!signalSymbol) return
    const brokers = ctx.brokersByUser.get(row.user_id) ?? []
    if (!brokers.length) return
    for (const broker of brokers) {
      const uuid = brokerSessionUuid(broker)
      if (!uuid) continue
      const api = ctx.apiFor(broker)
      if (!api) continue
      const mapping = applySymbolMapping(signalSymbol, broker)
      const requested = mapping.symbol
      void ctx.ensureBrokerSessionLiveFast(api, uuid, broker)
      void ctx.getSymbolList(uuid).catch(() => null)
      void ctx.getSymbolParams(uuid, requested).catch(() => null)
    }
  }

export async function prewarmBrokersForLiveEntry(ctx: TradeExecutorContext, brokers: BrokerRow[], signalSymbol: string): Promise<void> {
    await Promise.all(brokers.map(async broker => {
      const uuid = brokerSessionUuid(broker)
      if (!uuid) return
      const api = ctx.apiFor(broker)
      if (!api) return
      const mapping = applySymbolMapping(signalSymbol, broker)
      const requested = mapping.symbol
      await Promise.all([
        ctx.ensureBrokerSessionLiveFast(api, uuid, broker),
        ctx.getSymbolList(uuid).catch(() => null),
        ctx.getSymbolParams(uuid, requested).catch(() => null),
      ])
    }))
  }

export async function getSymbolParams(ctx: TradeExecutorContext, uuid: string, symbol: string): Promise<SymbolCacheEntry | null> {
    const key = `${uuid}:${symbol.toUpperCase()}`
    const cached = ctx.symbolCache.get(key)
    const now = Date.now()

    // Stale-while-revalidate: if we have ANY cached value, return it
    // immediately and kick off a background refresh when stale. The live
    // entry hot path therefore never waits on a broker round-trip after the
    // first signal for a symbol.
    if (cached) {
      const age = now - cached.loadedAt
      if (age >= SYMBOL_CACHE_STALE_MS && age < SYMBOL_CACHE_TTL_MS) {
        void ctx.refreshSymbolParams(uuid, symbol, key)
      }
      if (age < SYMBOL_CACHE_TTL_MS) return cached
    }

    if (!hasFxsocketConfigured()) return null
    return ctx.refreshSymbolParams(uuid, symbol, key)
  }

export async function refreshSymbolParams(ctx: TradeExecutorContext, 
    uuid: string,
    symbol: string,
    key?: string,
  ): Promise<SymbolCacheEntry | null> {
    const cacheKey = key ?? `${uuid}:${symbol.toUpperCase()}`
    const existing = ctx.symbolParamsInflight.get(cacheKey)
    if (existing) return existing

    const api = ctx.apiForUuid(uuid)
    if (!api) return null

    const promise = (async (): Promise<SymbolCacheEntry | null> => {
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
        if (!ctx.symbolCache.has(cacheKey)) {
          console.log(`[tradeExecutor] symbol params loaded uuid=${uuid} symbol=${symbol} digits=${entry.digits} point=${entry.point} contractSize=${entry.contractSize ?? 'default'} stopsLevel=${entry.stopsLevel} freezeLevel=${entry.freezeLevel} minLot=${entry.minLot} lotStep=${entry.lotStep}`)
        }
        ctx.symbolCache.set(cacheKey, entry)
        return entry
      } catch (e) {
        console.warn(`[tradeExecutor] /SymbolParams failed uuid=${uuid} symbol=${symbol}:`, e instanceof Error ? e.message : e)
        return null
      } finally {
        ctx.symbolParamsInflight.delete(cacheKey)
      }
    })()

    ctx.symbolParamsInflight.set(cacheKey, promise)
    return promise
  }

export async function getSymbolList(ctx: TradeExecutorContext, uuid: string): Promise<SymbolListCacheEntry | null> {
    const cached = ctx.symbolListCache.get(uuid)
    const now = Date.now()
    if (cached) {
      const age = now - cached.loadedAt
      if (age >= SYMBOL_CACHE_STALE_MS && age < SYMBOL_LIST_TTL_MS) {
        if (!ctx.symbolListInflight.has(uuid)) {
          const refresh = ctx.fetchSymbolList(uuid).finally(() => {
            ctx.symbolListInflight.delete(uuid)
          })
          ctx.symbolListInflight.set(uuid, refresh)
        }
      }
      if (age < SYMBOL_LIST_TTL_MS) return cached
    }

    const inflight = ctx.symbolListInflight.get(uuid)
    if (inflight) return inflight

    const fetchPromise = ctx.fetchSymbolList(uuid).finally(() => {
      ctx.symbolListInflight.delete(uuid)
    })
    ctx.symbolListInflight.set(uuid, fetchPromise)
    return fetchPromise
  }

export async function fetchSymbolList(ctx: TradeExecutorContext, uuid: string): Promise<SymbolListCacheEntry | null> {
    if (!hasFxsocketConfigured()) return null
    const api = ctx.apiForUuid(uuid)
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
      ctx.symbolListCache.set(uuid, entry)
      return entry
    } catch {
      return null
    }
  }

export function resolveBrokerSymbolFromInventory(ctx: TradeExecutorContext, 
    inventory: SymbolListCacheEntry,
    requested: string,
    opts?: { userDecorated?: boolean },
  ): string {
    const target = requested.toUpperCase()
    if (opts?.userDecorated === true) {
      if (inventory.set.has(target)) {
        const exact = inventory.list.find(s => s.toUpperCase() === target)
        return exact ?? requested
      }
      console.warn(
        `[tradeExecutor] user-decorated symbol not in broker /Symbols list: ${requested}`,
      )
      return requested
    }

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
      return exact ?? winner!
    }

    const contains = inventory.list.filter(s => s.toUpperCase().includes(target))
    if (contains.length === 1) return contains[0]!
    if (contains.length > 1) {
      contains.sort((a, b) => a.length - b.length)
      return contains[0]!
    }

    return requested
  }

export async function resolveBrokerSymbolForLiveEntry(
    ctx: TradeExecutorContext,
    uuid: string,
    requested: string,
    opts?: { userDecorated?: boolean },
  ): Promise<string> {
    const cached = ctx.symbolListCache.get(uuid)
    if (cached && (Date.now() - cached.loadedAt) < SYMBOL_LIST_TTL_MS) {
      return ctx.resolveBrokerSymbolFromInventory(cached, requested, opts)
    }
    const inventory = await ctx.getSymbolList(uuid)
    if (!inventory) return requested
    return ctx.resolveBrokerSymbolFromInventory(inventory, requested, opts)
  }

export async function resolveBrokerSymbol(
    ctx: TradeExecutorContext,
    uuid: string,
    requested: string,
    opts?: { userDecorated?: boolean },
  ): Promise<string> {
    const inventory = await ctx.getSymbolList(uuid)
    if (!inventory) return requested
    return ctx.resolveBrokerSymbolFromInventory(inventory, requested, opts)
  }
