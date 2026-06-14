import { supabase } from './supabase'
import type { BrokerAccount } from '../types/database'
import type { FxsocketStreamSubscribeFrame } from './fxsocketStreamTypes'

const FXSOCKET_EDGE_TIMEOUT_MS = 120_000
/** Full-account PositionHistory can require many chunked broker calls. */
const FXSOCKET_TRADES_TIMEOUT_MS = 180_000
const FXSOCKET_CONNECT_TIMEOUT_MS = 120_000
const FXSOCKET_WAIT_CONNECTED_MS = 180_000
const FXSOCKET_WAIT_CONNECTED_INTERVAL_MS = 1_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

interface CallOpts<T> {
  body: Record<string, unknown>
  expect?: (body: unknown) => T
  timeoutMs?: number
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

/** Validate / refresh the Supabase JWT before edge calls (avoids stale-session 401s). */
export async function ensureFreshAuthSession(): Promise<string> {
  const { data: userData, error: userErr } = await supabase.auth.getUser()
  if (userErr || !userData.user) throw new Error('Not signed in')

  const { data: sessionData } = await supabase.auth.getSession()
  const session = sessionData.session
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')

  const expiresAt = session.expires_at ?? 0
  const nowSec = Math.floor(Date.now() / 1000)
  if (expiresAt - nowSec > 120) return token

  const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
  if (refreshErr || !refreshed.session?.access_token) return token
  return refreshed.session.access_token
}

async function call<T = unknown>(opts: CallOpts<T>): Promise<T> {
  const url = (import.meta.env.VITE_SUPABASE_URL as string) + '/functions/v1/fxsocket-broker'
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
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
    const retryToken = refreshed.session?.access_token
    if (!refreshErr && retryToken) {
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

export const FXSOCKET_DOCS_URL = 'https://fxsocket.com/docs#request-builder'
export const FXSOCKET_V1_DOCS_URL = 'https://api.fxsocket.com/v1/docs#/'
export const FXSOCKET_BSA_DOCS_URL = 'https://bsa.fxsocket.com/docs'

export const fxsocketBroker = {
  searchBrokers(args: {
    platform: 'MT4' | 'MT5'
    company: string
  }): Promise<{ companies: BrokerSearchCompany[] }> {
    return call({
      body: { action: 'search_brokers', platform: args.platform, company: args.company },
      expect: (b) => {
        const row = b as { ok?: boolean; companies?: BrokerSearchCompany[] }
        return { companies: row.companies ?? [] }
      },
    })
  },

  list(): Promise<BrokerAccount[]> {
    return call({
      body: { action: 'list' },
      expect: (b) => {
        const rows = (b as { accounts?: BrokerAccount[] }).accounts
        return Array.isArray(rows) ? rows : []
      },
    })
  },

  connect(args: {
    label?: string
    login?: string
    password?: string
    server?: string
    fxsocketAccountId?: string
  }): Promise<{ account: BrokerAccount; pending?: boolean }> {
    return call({
      body: {
        action: 'connect',
        label: args.label,
        login: args.login,
        password: args.password,
        server: args.server,
        fxsocket_account_id: args.fxsocketAccountId,
      },
      timeoutMs: FXSOCKET_CONNECT_TIMEOUT_MS,
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
      onProgress?: (result: { account: BrokerAccount; summary?: AccountSummary; pending?: boolean }) => void
    },
  ): Promise<{ account: BrokerAccount; summary?: AccountSummary }> {
    const maxMs = opts?.maxMs ?? FXSOCKET_WAIT_CONNECTED_MS
    const intervalMs = opts?.intervalMs ?? FXSOCKET_WAIT_CONNECTED_INTERVAL_MS
    const started = Date.now()
    let lastError = 'Terminal connection timed out'

    while (Date.now() - started < maxMs) {
      try {
        const result = await call({
          body: { action: 'refresh_summary', account_id: accountId },
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
        if (!/timed out|connecting|pending|not ready/i.test(lastError)) throw e
      }
      await sleep(intervalMs)
    }

    throw new Error(lastError)
  },

  delete(accountId: string): Promise<void> {
    return call({
      body: { action: 'delete', account_id: accountId },
      expect: () => undefined,
    })
  },

  refreshSummary(accountId: string): Promise<{
    account: BrokerAccount
    summary?: AccountSummary
    pending?: boolean
  }> {
    return call({
      body: { action: 'refresh_summary', account_id: accountId },
      expect: (b) => {
        const row = b as { account?: BrokerAccount; summary?: AccountSummary; pending?: boolean }
        const account = row.account
        if (!account) throw new Error('Refresh did not return an account')
        const summary = row.summary
        return { account, summary, pending: row.pending === true }
      },
    })
  },

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
