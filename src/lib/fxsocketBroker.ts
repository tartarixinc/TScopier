import { supabase } from './supabase'
import type { BrokerAccount } from '../types/database'
import type { FxsocketMtStatus } from './fxsocketMtStatus'
import type { FxsocketStreamSubscribeFrame } from './fxsocketStreamTypes'
import { classifyBrokerConnectError } from './brokerConnectError'

const FXSOCKET_EDGE_TIMEOUT_MS = 120_000
/** Full-account PositionHistory can require many chunked broker calls. */
const FXSOCKET_TRADES_TIMEOUT_MS = 180_000
const FXSOCKET_CONNECT_TIMEOUT_MS = 120_000
/** Bulk CSV uploads queue several FxSocket provisions sequentially. */
export const FXSOCKET_BULK_CONNECT_TIMEOUT_MS = 300_000
const FXSOCKET_WAIT_CONNECTED_MS = 180_000
const FXSOCKET_WAIT_CONNECTED_INTERVAL_MS = 2_000

/** In-memory auth cache — avoids refreshSession on every edge poll during connect. */
let cachedAuth: { token: string; expiresAt: number } | null = null
/** Single-flight refresh so parallel fxsocket 401s don't hammer Auth and trip 429. */
let refreshInFlight: Promise<string | null> | null = null
let lastRefreshAttemptAt = 0
const REFRESH_COOLDOWN_MS = 15_000

function isAuthThrottleMessage(message: string | null | undefined): boolean {
  return /throttl|rate.?limit|too many requests|429/i.test(String(message ?? ''))
}

/**
 * At most one refreshSession at a time; cooldown after each attempt so a burst of
 * edge 401/503s cannot flood `/auth/v1/token?grant_type=refresh_token`.
 */
async function refreshAuthTokenSingleFlight(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight

  const now = Date.now()
  if (now - lastRefreshAttemptAt < REFRESH_COOLDOWN_MS) {
    return cachedAuth?.token ?? null
  }
  lastRefreshAttemptAt = now

  refreshInFlight = (async () => {
    try {
      const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
      if (refreshErr) {
        if (isAuthThrottleMessage(refreshErr.message) && cachedAuth?.token) {
          // Keep serving the existing JWT; do not clear session on Auth 429.
          cachedAuth = {
            token: cachedAuth.token,
            expiresAt: Math.max(cachedAuth.expiresAt, Math.floor(Date.now() / 1000) + 60),
          }
          return cachedAuth.token
        }
        return cachedAuth?.token ?? null
      }
      const nextToken = refreshed.session?.access_token
      const nextExpires = refreshed.session?.expires_at ?? 0
      if (!nextToken) return cachedAuth?.token ?? null
      cachedAuth = { token: nextToken, expiresAt: nextExpires }
      return nextToken
    } catch {
      return cachedAuth?.token ?? null
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

/** Validate / refresh the Supabase JWT before edge calls (avoids stale-session 401s). */
export async function ensureFreshAuthSession(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  if (cachedAuth && cachedAuth.expiresAt - nowSec > 120) {
    return cachedAuth.token
  }

  // Prefer local session — getUser() hits Auth on every call and amplifies rate limits.
  const { data: sessionData } = await supabase.auth.getSession()
  const session = sessionData.session
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')

  const expiresAt = session.expires_at ?? 0
  if (expiresAt - nowSec > 120) {
    cachedAuth = { token, expiresAt }
    return token
  }

  const refreshed = await refreshAuthTokenSingleFlight()
  if (refreshed) return refreshed

  cachedAuth = { token, expiresAt: Math.max(expiresAt, nowSec + 60) }
  return token
}

/** Accounts actively polled by waitUntilConnected — skip duplicate background sync. */
const waitConnectedAccountIds = new Set<string>()

export function isFxsocketApiThrottleError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /throttl|rate limit|too many requests|expected available in/i.test(msg)
}

export function parseFxsocketApiThrottleBackoffMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err)
  const m = /expected available in (\d+)\s*seconds?/i.exec(msg)
  if (m) return Math.max(1000, Number(m[1]) * 1000 + 500)
  return 8000
}

function isWaitingForConnect(accountId: string): boolean {
  return waitConnectedAccountIds.has(accountId)
}

/** Thrown when the edge function has not been deployed with terminal health support yet. */
export class BrokerHealthCheckUnsupportedError extends Error {
  constructor() {
    super('Broker terminal health check is not available on this server yet')
    this.name = 'BrokerHealthCheckUnsupportedError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

interface CallOpts<T> {
  body: Record<string, unknown>
  expect?: (body: unknown) => T
  timeoutMs?: number
  /** Edge function name — defaults to fxsocket-broker. Use 'mtapi-broker' for MTAPI accounts. */
  edgeFn?: string
}

function fxsocketFetchError(e: unknown, fallback: string): Error {
  if (e instanceof DOMException && e.name === 'TimeoutError') {
    return new Error('Broker request timed out. Try again in a moment.')
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return new Error('Broker request timed out. Try again in a moment.')
  }
  return e instanceof Error ? e : new Error(fallback)
}

async function call<T = unknown>(opts: CallOpts<T>): Promise<T> {
  const fnName = opts.edgeFn ?? 'fxsocket-broker'
  const url = (import.meta.env.VITE_SUPABASE_URL as string) + '/functions/v1/' + fnName
  const timeoutMs = opts.timeoutMs ?? FXSOCKET_EDGE_TIMEOUT_MS

  const doFetch = async (token: string): Promise<Response> => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        },
        body: JSON.stringify(opts.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw fxsocketFetchError(e, 'Broker request failed')
    }
  }

  let token = await ensureFreshAuthSession()
  let res = await doFetch(token)

  if (res.status === 401) {
    // Edge 401 is often gateway/config (or CORS-masked 503), not an expired JWT.
    // Refresh at most once via single-flight; skip if we already refreshed for this token.
    const retryToken = await refreshAuthTokenSingleFlight()
    if (retryToken && retryToken !== token) {
      token = retryToken
      res = await doFetch(token)
    }
  }

  const text = await res.text()
  let body: unknown = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>))
      ? String((body as Record<string, unknown>).error)
      : text || `HTTP ${res.status}`
    if (res.status === 429 || isFxsocketApiThrottleError(msg)) {
      throw new Error(msg || 'Request was throttled. Please wait a moment and try again.')
    }
    if (res.status === 504) {
      throw new Error('Trade history timed out loading from your broker. Try Refresh in a moment.')
    }
    throw new Error(msg)
  }
  return (opts.expect ? opts.expect(body) : (body as T))
}

export interface AccountSummary {
  balance?: number
  equity?: number
  currency?: string
  margin?: number
  freeMargin?: number
  marginLevel?: number
  leverage?: number
  profit?: number
  credit?: number
  type?: string
}

export interface BrokerSearchResult {
  name?: string
  access?: string[]
  logoUrl?: string | null
  site?: string | null
}

export interface BrokerSearchCompany {
  companyName?: string
  results?: BrokerSearchResult[]
}

export interface MtTrade {
  id: string
  broker_id: string
  broker_label: string
  broker_name: string | null
  ticket: number
  position_ticket?: number | null
  symbol: string
  direction: 'buy' | 'sell' | ''
  type: string
  lot_size: number
  entry_price: number | null
  sl: number | null
  tp: number | null
  close_price: number | null
  profit: number | null
  swap: number | null
  commission: number | null
  comment: string | null
  magic: number | null
  opened_at: string | null
  closed_at: string | null
  state: string | null
  status: 'open' | 'closed'
}

export type { FxsocketStreamSubscribeFrame } from './fxsocketStreamTypes'

export const FXSOCKET_DOCS_URL = 'https://fxsocket.com/docs#request-builder'
export const FXSOCKET_V1_DOCS_URL = 'https://api.fxsocket.com/v1/docs#/'

function fetchBrokerStatusCall(
  accountId: string,
  provider?: 'fxsocket' | 'mtapi',
): Promise<{
  account: BrokerAccount
  healthy: boolean
  status: FxsocketMtStatus
}> {
  return call({
    body: { action: 'broker_status', account_id: accountId },
    edgeFn: provider === 'mtapi' ? 'mtapi-broker' : undefined,
    timeoutMs: 15_000,
    expect: (b) => {
      const row = b as {
        account?: BrokerAccount
        healthy?: boolean
        status?: FxsocketMtStatus
      }
      const account = row.account
      const status = row.status
      if (!account || !status || typeof status !== 'object') {
        throw new BrokerHealthCheckUnsupportedError()
      }
      return { account, healthy: row.healthy === true, status }
    },
  })
}

export const fxsocketBroker = {
  list(): Promise<BrokerAccount[]> {
    return call({
      body: { action: 'list' },
      expect: (b) => {
        const rows = (b as { accounts?: BrokerAccount[] }).accounts
        return Array.isArray(rows) ? rows : []
      },
    })
  },

  searchBrokers(args: {
    company: string
    platform?: 'MT4' | 'MT5'
  }): Promise<{ companies: BrokerSearchCompany[] }> {
    return call({
      body: {
        action: 'search_brokers',
        company: args.company,
        platform: args.platform ?? 'MT5',
      },
      expect: (b) => {
        const row = b as { companies?: BrokerSearchCompany[] }
        return { companies: row.companies ?? [] }
      },
    })
  },

  connect(args: {
    label?: string
    login?: string
    password?: string
    server?: string
    platform?: 'MT4' | 'MT5'
    fxsocketAccountId?: string
    provider?: 'fxsocket' | 'mtapi'
    timeoutMs?: number
  }): Promise<{ account: BrokerAccount; pending?: boolean }> {
    return call({
      body: {
        action: 'connect',
        label: args.label,
        login: args.login,
        password: args.password,
        server: args.server,
        platform: args.platform ?? 'MT5',
        fxsocket_account_id: args.fxsocketAccountId,
      },
      edgeFn: args.provider === 'mtapi' ? 'mtapi-broker' : undefined,
      timeoutMs: args.timeoutMs ?? FXSOCKET_CONNECT_TIMEOUT_MS,
      expect: (b) => {
        const row = b as { account?: BrokerAccount; pending?: boolean }
        const account = row.account
        if (!account) throw new Error('Connect did not return an account')
        return { account, pending: row.pending === true }
      },
    })
  },

  /** Poll refresh_summary until the FxSocket terminal reaches connected (or error). */
  async waitUntilConnected(
    accountId: string,
    opts?: {
      maxMs?: number
      intervalMs?: number
      provider?: 'fxsocket' | 'mtapi'
      onProgress?: (result: { account: BrokerAccount; summary?: AccountSummary; pending?: boolean }) => void
    },
  ): Promise<{ account: BrokerAccount; summary?: AccountSummary }> {
    const maxMs = opts?.maxMs ?? FXSOCKET_WAIT_CONNECTED_MS
    const intervalMs = opts?.intervalMs ?? FXSOCKET_WAIT_CONNECTED_INTERVAL_MS
    const started = Date.now()
    let lastError = 'Terminal connection timed out'

    waitConnectedAccountIds.add(accountId)
    try {
      while (Date.now() - started < maxMs) {
        try {
          const result = await call({
            body: { action: 'refresh_summary', account_id: accountId },
            edgeFn: opts?.provider === 'mtapi' ? 'mtapi-broker' : undefined,
            expect: (b) => {
              const row = b as { account?: BrokerAccount; summary?: AccountSummary; pending?: boolean }
              const account = row.account
              if (!account) throw new Error('Refresh did not return an account')
              return { account, summary: row.summary, pending: row.pending === true }
            },
          })
          opts?.onProgress?.(result)
          if (result.account.connection_status === 'connected') return result
          if (result.account.connection_status === 'error') {
            throw new Error(result.account.connection_error ?? 'Broker connection failed')
          }
        } catch (e) {
          lastError = e instanceof Error ? e.message : lastError
          if (isFxsocketApiThrottleError(lastError)) {
            await sleep(parseFxsocketApiThrottleBackoffMs(lastError))
            continue
          }
          // Transient terminal startup failures classify as terminal_not_ready —
          // keep polling until the MT terminal finishes spinning up or maxMs elapses.
          if (classifyBrokerConnectError(lastError) === 'terminal_not_ready') {
            await sleep(intervalMs)
            continue
          }
          if (!/timed out|connecting|pending|not ready/i.test(lastError)) throw e
        }
        await sleep(intervalMs)
      }

      throw new Error(lastError)
    } finally {
      waitConnectedAccountIds.delete(accountId)
    }
  },

  isWaitingForConnect(accountId: string): boolean {
    return isWaitingForConnect(accountId)
  },

  /** Re-link FxSocket on an existing broker row (password required; config preserved). */
  reconnect(args: {
    accountId: string
    password: string
    server?: string
    provider?: 'fxsocket' | 'mtapi'
    timeoutMs?: number
  }): Promise<{ account: BrokerAccount; pending?: boolean }> {
    return call({
      body: {
        action: 'reconnect',
        account_id: args.accountId,
        password: args.password,
        server: args.server,
      },
      edgeFn: args.provider === 'mtapi' ? 'mtapi-broker' : undefined,
      timeoutMs: args.timeoutMs ?? FXSOCKET_CONNECT_TIMEOUT_MS,
      expect: (b) => {
        const row = b as { account?: BrokerAccount; pending?: boolean }
        const account = row.account
        if (!account) throw new Error('Reconnect did not return an account')
        return { account, pending: row.pending === true }
      },
    })
  },

  delete(accountId: string, provider?: 'fxsocket' | 'mtapi'): Promise<void> {
    return call({
      body: { action: 'delete', account_id: accountId },
      edgeFn: provider === 'mtapi' ? 'mtapi-broker' : undefined,
      expect: () => undefined,
    })
  },

  refreshSummary(accountId: string, provider?: 'fxsocket' | 'mtapi'): Promise<{
    account: BrokerAccount
    summary?: AccountSummary
    pending?: boolean
  }> {
    return call({
      body: { action: 'refresh_summary', account_id: accountId },
      edgeFn: provider === 'mtapi' ? 'mtapi-broker' : undefined,
      expect: (b) => {
        const row = b as { account?: BrokerAccount; summary?: AccountSummary; pending?: boolean }
        const account = row.account
        if (!account) throw new Error('Refresh did not return an account')
        const summary = row.summary
        return { account, summary, pending: row.pending === true }
      },
    })
  },

  checkStatus: fetchBrokerStatusCall,

  fetchBrokerStatus: fetchBrokerStatusCall,

  /** Lightweight AccountSummary poll — no baseline/history work (for live Open P/L). */
  liveSnapshot(accountId: string): Promise<{ summary: AccountSummary }> {
    return call({
      body: { action: 'live_snapshot', account_id: accountId },
      timeoutMs: 12_000,
      expect: (b) => {
        const row = b as { summary?: AccountSummary }
        const summary = row.summary
        if (!summary || typeof summary !== 'object') throw new Error('Live snapshot missing summary')
        return { summary }
      },
    })
  },

  /** Worker WS URL from server WORKER_PUBLIC_URL (trade worker with /broker/stream). */
  streamTicket(accountId: string): Promise<{ ws_url: string }> {
    return call({
      body: { action: 'stream_ticket', account_id: accountId },
      expect: (b) => {
        const row = b as { ws_url?: string }
        const ws_url = String(row.ws_url ?? '').trim()
        if (!ws_url) throw new Error('stream_ticket did not return ws_url')
        return { ws_url }
      },
    })
  },

  openedOrders(accountId: string): Promise<unknown[]> {
    return call({
      body: { action: 'opened_orders', account_id: accountId },
      expect: (b) => {
        const orders = (b as { orders?: unknown[] }).orders
        return Array.isArray(orders) ? orders : []
      },
    })
  },

  quote(accountId: string, symbol = 'EURUSD'): Promise<Record<string, unknown>> {
    return call({
      body: { action: 'quote', account_id: accountId, symbol },
      expect: (b) => {
        const quote = (b as { quote?: Record<string, unknown> }).quote
        return quote && typeof quote === 'object' ? quote : {}
      },
    })
  },

  symbols(accountId: string): Promise<string[]> {
    return call({
      body: { action: 'symbols', account_id: accountId },
      expect: (b) => {
        const symbols = (b as { symbols?: string[] }).symbols
        return Array.isArray(symbols) ? symbols.map(String) : []
      },
    })
  },

  orderHistory(args: {
    accountId: string
    from: string
    to: string
  }): Promise<unknown[]> {
    return call({
      body: {
        action: 'order_history',
        account_id: args.accountId,
        history_from: args.from,
        history_to: args.to,
      },
      timeoutMs: FXSOCKET_EDGE_TIMEOUT_MS,
      expect: (b) => {
        const orders = (b as { orders?: unknown[] }).orders
        return Array.isArray(orders) ? orders : []
      },
    })
  },

  positionHistory(args: {
    accountId: string
    from: string
    to: string
  }): Promise<unknown[]> {
    return call({
      body: {
        action: 'position_history',
        account_id: args.accountId,
        history_from: args.from,
        history_to: args.to,
      },
      timeoutMs: FXSOCKET_EDGE_TIMEOUT_MS,
      expect: (b) => {
        const positions = (b as { positions?: unknown[] }).positions
        return Array.isArray(positions) ? positions : []
      },
    })
  },

  trades(args: {
    brokerId?: string
    scope?: 'all' | 'open' | 'closed'
    historyFrom?: string
    historyTo?: string
    historyProfile?: 'dashboard' | 'trades'
    limit?: number
    includeBalanceCashflow?: boolean
  } = {}): Promise<{ trades: MtTrade[] }> {
    return call({
      body: {
        action: 'trades',
        broker_id: args.brokerId ?? '',
        scope: args.scope ?? 'all',
        history_profile: args.historyProfile ?? 'dashboard',
        ...(args.historyFrom ? { history_from: args.historyFrom } : {}),
        ...(args.historyTo ? { history_to: args.historyTo } : {}),
        ...(args.limit != null && args.limit > 0 ? { limit: args.limit } : {}),
        ...(args.includeBalanceCashflow === false ? { include_balance_cashflow: false } : {}),
      },
      timeoutMs: FXSOCKET_TRADES_TIMEOUT_MS,
      expect: (b) => b as { trades: MtTrade[] },
    })
  },

  /** Client-side frame for subscribing to a ticket on the worker stream proxy. */
  streamSubscribeFrame(ticket: number): FxsocketStreamSubscribeFrame {
    return { action: 'subscribe', topic: 'trades', ticket }
  },

  swaggerUrl(fxsocketAccountId: string): string {
    const id = encodeURIComponent(fxsocketAccountId.trim())
    return `https://api.fxsocket.com/mt5/${id}/swagger-ui/`
  },
}
