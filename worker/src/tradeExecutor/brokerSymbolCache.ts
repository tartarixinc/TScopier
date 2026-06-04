import type { TradeExecutorContext } from './context'
import type { ParsedSignal } from './types'
import {
  hasMetatraderApiConfigured,
  MetatraderApiClient,
  normalizeSymbolParams,
  type SymbolParams,
} from '../metatraderapi'
import type { ManualSettings } from '../manualPlanner'
import { writeBrokerConnectionStatus } from '../brokerConnectionStatus'
import { hardReconnectBrokerSession } from '../brokerHardReconnect'
import { pauseIfSameMtServer } from '../mtServerSessionLock'
import { applySymbolMapping, isMtUuid, parseSymbolToTradeList } from './helpers'
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
const heartbeatFailCounts = new Map<string, number>()

export function resetBrokerHeartbeatFailures(brokerId: string): void {
  heartbeatFailCounts.delete(brokerId)
}

export function prewarmSymbolsEnabled(ctx: TradeExecutorContext, ): boolean {
    const v = String(process.env.EXECUTOR_PREWARM_SYMBOLS ?? 'true').toLowerCase()
    return v !== '0' && v !== 'false' && v !== 'no'
  }

export async function prewarmBrokerCaches(ctx: TradeExecutorContext, ): Promise<void> {
    if (!ctx.prewarmSymbolsEnabled() || !hasMetatraderApiConfigured()) return
    for (const row of ctx.brokersById.values()) {
      const uuid = row.metaapi_account_id
      if (!isMtUuid(uuid)) continue
      void ctx.getSymbolList(uuid!)
      const manual = (row.manual_settings ?? {}) as { symbol_to_trade?: string | null }
      const symbols = parseSymbolToTradeList(manual.symbol_to_trade)
      for (const sym of symbols.length > 0 ? symbols : ['XAUUSD', 'EURUSD']) {
        // Cache under BOTH the canonical signal symbol and the broker-mapped
        // variant (e.g. XAUUSD → XAUUSDm). Otherwise the live path looks up
        // the mapped key and misses every time.
        const mapping = applySymbolMapping(sym, row)
        void ctx.getSymbolParams(uuid!, mapping.symbol).catch(() => null)
        if (mapping.symbol.toUpperCase() !== sym.toUpperCase()) {
          void ctx.getSymbolParams(uuid!, sym).catch(() => null)
        }
      }
    }
  }

export async function sessionHeartbeatTick(ctx: TradeExecutorContext, ): Promise<void> {
    if (!hasMetatraderApiConfigured()) return

    const rows = [...ctx.brokersById.values()]
      .filter(row => isMtUuid(row.metaapi_account_id))
      .sort((a, b) => {
        const ak = `${a.platform}:${String(a.broker_server ?? '').trim().toLowerCase()}`
        const bk = `${b.platform}:${String(b.broker_server ?? '').trim().toLowerCase()}`
        return ak.localeCompare(bk)
      })

    let lastServerKey: string | null = null

    for (const row of rows) {
      const uuid = row.metaapi_account_id
      if (!isMtUuid(uuid)) continue
      lastServerKey = await pauseIfSameMtServer(lastServerKey, row.platform, row.broker_server)
      const api = ctx.apiFor(row)
      if (!api) continue

      const markRecovered = async () => {
        heartbeatFailCounts.delete(row.id)
        ctx.sessionPingAt.set(uuid!, Date.now())
        if (row.connection_status === 'error') {
          row.connection_status = 'connected'
          await writeBrokerConnectionStatus(ctx.supabase, row.id, 'connected')
        }
      }

      const initialStatus = await api.keepSessionAliveDetailed(uuid!)
      if (initialStatus === 'alive') {
        await markRecovered()
        continue
      }
      if (initialStatus !== 'session_gone') {
        await new Promise(r => setTimeout(r, 2000))
        const retryStatus = await api.keepSessionAliveDetailed(uuid!)
        if (retryStatus === 'alive') {
          await markRecovered()
          continue
        }
      }

      if (
        row.auto_reconnect_enabled
        && row.mt_password_encrypted
        && row.account_login
        && row.broker_server
      ) {
        const hardOk = await hardReconnectBrokerSession(ctx.supabase, api, {
          id: row.id,
          platform: row.platform,
          metaapi_account_id: uuid!,
          account_login: row.account_login,
          broker_server: row.broker_server,
          auto_reconnect_enabled: row.auto_reconnect_enabled,
          mt_password_encrypted: row.mt_password_encrypted,
        })
        if (hardOk) {
          await markRecovered()
          continue
        }
      }

      const fails = (heartbeatFailCounts.get(row.id) ?? 0) + 1
      heartbeatFailCounts.set(row.id, fails)
      if (fails < HEARTBEAT_FAILURES_BEFORE_DOWN) {
        console.warn(
          `[tradeExecutor] broker ${row.id} heartbeat miss (${fails}/${HEARTBEAT_FAILURES_BEFORE_DOWN})`,
        )
        continue
      }

      await markBrokerSessionDown(ctx, row, uuid!, 'heartbeat keepSessionAlive failed')
    }
  }

export async function symbolCacheKeepaliveTick(ctx: TradeExecutorContext, ): Promise<void> {
    if (!hasMetatraderApiConfigured()) return
    if (!ctx.prewarmSymbolsEnabled()) return

    const uuidsWithList = [...ctx.symbolListCache.keys()]
    await Promise.all(uuidsWithList.map(async uuid => {
      try {
        const fresh = await ctx.fetchSymbolList(uuid)
        if (fresh) ctx.symbolListCache.set(uuid, fresh)
      } catch { /* best-effort */ }
    }))

    const paramsKeys = [...ctx.symbolCache.keys()]
    await Promise.all(paramsKeys.map(async key => {
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
  }

export async function reconnectCachedBrokers(ctx: TradeExecutorContext, ) {
    ctx.sessionOrderBlocked.clear()
    const rows = [...ctx.brokersById.values()]
      .filter(row => row.metaapi_account_id && !row.metaapi_account_id.includes('|'))
      .sort((a, b) => {
        const ak = `${a.platform}:${String(a.broker_server ?? '').trim().toLowerCase()}`
        const bk = `${b.platform}:${String(b.broker_server ?? '').trim().toLowerCase()}`
        return ak.localeCompare(bk)
      })

    let lastServerKey: string | null = null
    for (const row of rows) {
      lastServerKey = await pauseIfSameMtServer(lastServerKey, row.platform, row.broker_server)
      const uuid = row.metaapi_account_id
      if (!uuid) continue
      const api = ctx.apiFor(row)
      if (!api) continue
      const alive = await api.keepSessionAlive(uuid)
      if (alive) {
        heartbeatFailCounts.delete(row.id)
        ctx.sessionPingAt.set(uuid, Date.now())
        if (row.connection_status !== 'connected') {
          console.log(`[tradeExecutor] broker=${row.id} recovered on startup`)
          row.connection_status = 'connected'
          await writeBrokerConnectionStatus(ctx.supabase, row.id, 'connected')
        }
      } else {
        console.warn(`[tradeExecutor] session not alive for broker=${row.id} on startup`)
        row.connection_status = 'error'
        await writeBrokerConnectionStatus(ctx.supabase, row.id, 'error', {
          rawError: 'session not alive on startup',
        })
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

export async function pingBrokerSession(ctx: TradeExecutorContext, row: BrokerRow): Promise<void> {
    const uuid = row.metaapi_account_id
    if (!isMtUuid(uuid)) return
    const api = ctx.apiFor(row)
    if (!api) return
    const ready = await api.verifyTradingReady(uuid!)
    if (ready) {
      ctx.sessionPingAt.set(uuid!, Date.now())
      return
    }
    await ctx.markBrokerSessionDown(row, uuid!, 'verifyTradingReady failed')
  }

export async function ensureBrokerSession(ctx: TradeExecutorContext, 
    api: MetatraderApiClient,
    uuid: string,
    broker: BrokerRow,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    if (ctx.sessionOrderBlocked.has(broker.id)) {
      await ctx.markBrokerSessionDown(broker, uuid, 'session blocked after prior OrderSend disconnect')
      return false
    }
    const now = Date.now()
    const last = ctx.sessionPingAt.get(uuid) ?? 0
    if (!opts?.force && now - last < SESSION_PING_MIN_INTERVAL_MS) return true
    const ready = await api.verifyTradingReady(uuid)
    if (ready) {
      ctx.sessionPingAt.set(uuid, now)
      return true
    }
    await ctx.markBrokerSessionDown(broker, uuid, 'verifyTradingReady failed before OrderSend')
    return false
  }

export async function ensureBrokerSessionLiveFast(ctx: TradeExecutorContext, 
    api: MetatraderApiClient,
    uuid: string,
    broker: BrokerRow,
  ): Promise<boolean> {
    if (ctx.sessionOrderBlocked.has(broker.id)) {
      await ctx.markBrokerSessionDown(broker, uuid, 'session blocked after prior OrderSend disconnect')
      return false
    }
    const now = Date.now()
    const last = ctx.sessionPingAt.get(uuid) ?? 0
    if (now - last < SESSION_PING_MIN_INTERVAL_MS) return true

    const inflight = ctx.sessionCheckInflight.get(uuid)
    if (inflight) return inflight

    const check = (async () => {
      try {
        const alive = await api.keepSessionAlive(uuid)
        if (alive) {
          ctx.sessionPingAt.set(uuid, Date.now())
          return true
        }
        await ctx.markBrokerSessionDown(broker, uuid, 'keepSessionAlive failed before live OrderSend')
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
      const uuid = broker.metaapi_account_id
      if (!isMtUuid(uuid)) continue
      if (ctx.sessionOrderBlocked.has(broker.id)) return false
      const lastPing = ctx.sessionPingAt.get(uuid!) ?? 0
      if (now - lastPing >= SESSION_PING_MIN_INTERVAL_MS) return false
      const symbolList = ctx.symbolListCache.get(uuid!)
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
    if (!hasMetatraderApiConfigured()) return
    const parsed = row.parsed_data as ParsedSignal | null
    const signalSymbol = parsed?.symbol
    if (!signalSymbol) return
    const brokers = ctx.brokersByUser.get(row.user_id) ?? []
    if (!brokers.length) return
    for (const broker of brokers) {
      const uuid = broker.metaapi_account_id
      if (!isMtUuid(uuid)) continue
      const mapping = applySymbolMapping(signalSymbol, broker)
      const requested = mapping.symbol
      void ctx.getSymbolList(uuid!).catch(() => null)
      void ctx.getSymbolParams(uuid!, requested).catch(() => null)
    }
  }

export async function prewarmBrokersForLiveEntry(ctx: TradeExecutorContext, brokers: BrokerRow[], signalSymbol: string): Promise<void> {
    await Promise.all(brokers.map(async broker => {
      const uuid = broker.metaapi_account_id
      if (!isMtUuid(uuid)) return
      const api = ctx.apiFor(broker)
      if (!api) return
      const mapping = applySymbolMapping(signalSymbol, broker)
      const requested = mapping.symbol
      await Promise.all([
        ctx.ensureBrokerSessionLiveFast(api, uuid!, broker),
        ctx.getSymbolList(uuid!).catch(() => null),
        ctx.getSymbolParams(uuid!, requested).catch(() => null),
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

    if (!hasMetatraderApiConfigured()) return null
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
    if (!hasMetatraderApiConfigured()) return null
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
