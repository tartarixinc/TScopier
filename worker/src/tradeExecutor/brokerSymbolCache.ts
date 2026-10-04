import type { TradeExecutorContext } from './context'
import type { ParsedSignal } from './types'
import {
  FxsocketBrokerClient,
  normalizeSymbolParams,
  type SymbolParams,
} from '../fxsocketClient'
import { writeBrokerConnectionStatus } from '../brokerConnectionStatus'
import { writeBrokerTerminalUnhealthy } from '../brokerTerminalHealth'
import { applySymbolMapping, brokerSessionUuid, isMtUuid, parseSymbolToTradeList } from './helpers'
import { isDerivSyntheticSymbol, resolveDerivCanonicalToBrokerSymbol } from '../derivSymbols'
import {
  clearLegacySymbolDecorationIfPresent,
} from './brokerSymbolDecoration'
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
const symbolInventoryReadyHandled = new Set<string>()

const SYMBOL_AUTO_MATCH_PROBES = [
  'EURUSD',
  'XAUUSD',
  'GBPUSD',
  'BTCUSD',
  'NAS100',
  'US500',
  'US30',
  'GER40',
  'UK100',
  'JP225',
] as const

const BROKER_SYMBOL_SUFFIXES = [
  '',
  'M',
  '.M',
  'M.RAW',
  '.RAW',
  '.PRO',
  '.R',
  '_R',
  '.I',
  '_I',
  '.C',
  '_C',
  '.S',
  '_S',
  '.X',
  '_X',
  '.A',
  '_A',
  '.CASH',
  '_CASH',
  '#',
  '+',
]
const BROKER_SYMBOL_PREFIXES = ['', '#', '_', 'M']

export const INDEX_ALIAS_FAMILIES = [
  {
    id: 'nasdaq100',
    aliases: ['NAS100', 'US100', 'USTEC', 'NDX', 'NASDAQ100'],
  },
  {
    id: 'sp500',
    aliases: ['US500', 'SPX500', 'SP500', 'S&P500', 'SPX'],
  },
  {
    id: 'dow30',
    aliases: ['US30', 'DJ30', 'DJIA', 'DOW30', 'WS30'],
  },
  {
    id: 'dax',
    aliases: ['GER40', 'DE40', 'DAX40', 'GER30', 'DAX'],
  },
  {
    id: 'ftse100',
    aliases: ['UK100', 'FTSE100', 'FTSE'],
  },
  {
    id: 'nikkei225',
    aliases: ['JP225', 'JPN225', 'NIKKEI225', 'N225'],
  },
] as const

function normalizeIndexAliasToken(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function indexAliasFamilyFor(symbol: string): typeof INDEX_ALIAS_FAMILIES[number] | null {
  const normalized = normalizeIndexAliasToken(symbol)
  return INDEX_ALIAS_FAMILIES.find(family =>
    family.aliases.some(alias => normalizeIndexAliasToken(alias) === normalized),
  ) ?? null
}

function exactInventorySymbol(inventory: SymbolListCacheEntry, symbolUpper: string): string | null {
  if (!inventory.set.has(symbolUpper)) return null
  return inventory.list.find(s => s.toUpperCase() === symbolUpper) ?? symbolUpper
}

function decoratedInventoryCandidates(inventory: SymbolListCacheEntry, symbolUpper: string): string[] {
  const candidates: string[] = []
  for (const p of BROKER_SYMBOL_PREFIXES) {
    for (const s of BROKER_SYMBOL_SUFFIXES) {
      const c = `${p}${symbolUpper}${s}`
      if (c !== symbolUpper && inventory.set.has(c)) candidates.push(c)
    }
  }
  candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))
  return candidates.map(candidate =>
    inventory.list.find(s => s.toUpperCase() === candidate) ?? candidate,
  )
}

/**
 * Map canonical metals (XAUUSD / GOLD) onto broker names like GOLD# (XM) when
 * suffix/contains heuristics cannot rename XAUUSD → GOLD.
 * Avoid equity lookalikes (BarrickGold, Gold Fields, Goldman…).
 */
export function resolveMetalAliasFromInventory(
  inventory: SymbolListCacheEntry,
  requested: string,
): string | null {
  const target = requested.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const isXau =
    target === 'XAUUSD'
    || target === 'XAU'
    || target === 'GOLD'
    || target === 'XAUUSDM'
  if (!isXau) return null

  const preferred = [
    'GOLD#',
    'GOLD',
    'XAUUSD#',
    'XAUUSDM',
    'XAUUSD.M',
    'XAUUSD+',
    'XAUUSD.',
    'GOLD24-7#',
    'GOLD24-7',
  ]
  for (const p of preferred) {
    if (inventory.set.has(p)) {
      return inventory.list.find(s => s.toUpperCase() === p) ?? p
    }
  }

  const candidates = inventory.list.filter(s => {
    const u = s.toUpperCase()
    if (/^XAUUSD([.#+\-_M].*)?$/i.test(u)) return true
    // GOLD / GOLD# / GOLDm / GOLD.r / GOLD24-7# — not BarrickGold / GoldmSachs / Gold Fields
    if (u === 'GOLD' || u === 'GOLDM') return true
    if (/^GOLD#/.test(u)) return true
    if (/^GOLD[.#+\-_]/.test(u)) return true
    if (/^GOLD\d/.test(u)) return true
    return false
  })
  if (candidates.length === 0) return null

  const score = (s: string): number => {
    const u = s.toUpperCase()
    if (u === 'GOLD#') return 0
    if (u === 'GOLD') return 1
    if (u.startsWith('GOLD')) return 2
    if (u.startsWith('XAUUSD')) return 3
    return 4
  }
  candidates.sort((a, b) => score(a) - score(b) || a.length - b.length)
  return candidates[0] ?? null
}

export function resolveIndexAliasFromInventory(
  inventory: SymbolListCacheEntry,
  requested: string,
): string | null {
  const family = indexAliasFamilyFor(requested)
  if (!family) return null

  const matches = new Map<string, string>()
  for (const alias of family.aliases) {
    const aliasUpper = alias.toUpperCase()
    const exact = exactInventorySymbol(inventory, aliasUpper)
    if (exact) {
      matches.set(normalizeIndexAliasToken(alias), exact)
      continue
    }

    const decorated = decoratedInventoryCandidates(inventory, aliasUpper)
    if (decorated.length === 1) {
      matches.set(normalizeIndexAliasToken(alias), decorated[0]!)
    } else if (decorated.length > 1) {
      console.warn(
        `[tradeExecutor] ambiguous decorated index alias family=${family.id} requested=${requested}`,
      )
      return null
    }
  }

  if (matches.size === 1) return [...matches.values()][0]!
  if (matches.size > 1) {
    console.warn(
      `[tradeExecutor] ambiguous index alias family=${family.id} requested=${requested}`,
    )
  }
  return null
}

function findBrokerBySessionUuid(ctx: TradeExecutorContext, uuid: string): BrokerRow | undefined {
  for (const broker of ctx.brokersById.values()) {
    if (brokerSessionUuid(broker) === uuid) return broker
  }
  return undefined
}

async function onBrokerSymbolInventoryReady(
  ctx: TradeExecutorContext,
  uuid: string,
  inventory: SymbolListCacheEntry,
): Promise<void> {
  if (symbolInventoryReadyHandled.has(uuid)) return
  const broker = findBrokerBySessionUuid(ctx, uuid)
  if (!broker || broker.connection_status !== 'connected') return

  symbolInventoryReadyHandled.add(uuid)
  await clearLegacySymbolDecorationIfPresent(ctx.supabase, broker)

  const parts: string[] = []
  for (const probe of SYMBOL_AUTO_MATCH_PROBES) {
    const resolved = resolveBrokerSymbolFromInventory(ctx, inventory, probe)
    if (resolved.toUpperCase() !== probe) {
      parts.push(`${probe}→${resolved}`)
    }
  }
  if (parts.length > 0) {
    console.log(
      `[tradeExecutor] symbol auto-match broker=${broker.id} ${parts.join(' ')}`,
    )
  }
}

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
  // No network keepSessionAlive — FxSocket terminals are self-hosted and stay up.
  void api
  void opts
  if (ctx.sessionOrderBlocked.has(broker.id)) return false
  ctx.sessionPingAt.set(uuid, Date.now())
  return true
}

export function prewarmSymbolsEnabled(ctx: TradeExecutorContext, ): boolean {
    void ctx
    const v = String(process.env.EXECUTOR_PREWARM_SYMBOLS ?? 'true').toLowerCase()
    return v !== '0' && v !== 'false' && v !== 'no'
  }

export async function prewarmBrokerCaches(ctx: TradeExecutorContext, ): Promise<void> {
    if (!ctx.prewarmSymbolsEnabled()) return
    for (const row of ctx.brokersById.values()) {
      const uuid = brokerSessionUuid(row)
      if (!uuid) continue
      prewarmBrokerSymbolCaches(ctx, row)
    }
  }

export async function sessionHeartbeatTick(ctx: TradeExecutorContext): Promise<void> {
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

export async function reconnectCachedBrokers(ctx: TradeExecutorContext): Promise<void> {
  void ctx
  /* FxSocket manages terminal lifecycle */
}

export async function pingBrokerSession(ctx: TradeExecutorContext, row: BrokerRow): Promise<void> {
  if (!row.is_active) return
  const uuid = brokerSessionUuid(row)
  if (!uuid) return
  const api = ctx.apiFor(row)
  if (!api) return
  await pingBrokerSessionInner(ctx, row, api, uuid, { force: true })
}

export async function symbolCacheKeepaliveTick(ctx: TradeExecutorContext, ): Promise<void> {
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
    await writeBrokerTerminalUnhealthy(ctx.supabase, broker.id, { force: true })
  }

/**
 * Symmetric counterpart to markBrokerSessionDown. The worker is the sole writer
 * of connection_status but otherwise only ever degrades it to 'error'; without
 * this, a row stays stuck 'error' forever after a transient heartbeat blip even
 * once the session recovers. Called from every heartbeat success path.
 */
export async function markBrokerSessionRecovered(ctx: TradeExecutorContext, broker: BrokerRow): Promise<void> {
    // Always write connected (force) so sticky connection_error_kind left by
    // edge refresh_summary / partial patches cannot survive a healthy heartbeat.
    broker.connection_status = 'connected'
    await writeBrokerConnectionStatus(ctx.supabase, broker.id, 'connected', { force: true })
  }

export async function ensureBrokerSession(ctx: TradeExecutorContext,
    api: FxsocketBrokerClient,
    uuid: string,
    broker: BrokerRow,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    // FxSocket self-hosted terminals need no proactive checkConnect. Only skip when
    // a prior real OrderSend disconnect blocked this broker.
    void api
    void opts
    if (ctx.sessionOrderBlocked.has(broker.id)) return false
    ctx.sessionPingAt.set(uuid, Date.now())
    return true
  }

export async function ensureBrokerSessionLiveFast(ctx: TradeExecutorContext, 
    api: FxsocketBrokerClient,
    uuid: string,
    broker: BrokerRow,
  ): Promise<boolean> {
    void api
    if (ctx.sessionOrderBlocked.has(broker.id)) return false
    ctx.sessionPingAt.set(uuid, Date.now())
    return true
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
      void onBrokerSymbolInventoryReady(ctx, uuid, entry).catch(err => {
        console.warn(
          `[tradeExecutor] symbol inventory ready hook failed uuid=${uuid}:`,
          err instanceof Error ? err.message : err,
        )
      })
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

    // Deriv synthetics: the canonical code (R_75, BOOM1000…) rarely matches the
    // broker's display name (`Volatility 75 Index`), so resolve via the Deriv
    // alias map before the generic FX suffix/contains heuristics. The synthetic
    // gate is broker-safe — only canonical synthetic codes ever reach here.
    if (isDerivSyntheticSymbol(target)) {
      const brokerSymbol = resolveDerivCanonicalToBrokerSymbol(target, inventory.list)
      if (brokerSymbol) return brokerSymbol
      console.warn(
        `[tradeExecutor] Deriv synthetic ${requested} not found in broker /Symbols list`,
      )
      return requested
    }

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

    const candidates = decoratedInventoryCandidates(inventory, target)
    if (candidates.length) {
      const winner = candidates[0]
      return winner!
    }

    const metal = resolveMetalAliasFromInventory(inventory, target)
    if (metal) return metal

    const indexAlias = resolveIndexAliasFromInventory(inventory, target)
    if (indexAlias) return indexAlias

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
