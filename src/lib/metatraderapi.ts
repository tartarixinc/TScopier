import { supabase } from './supabase'
import type { BrokerAccount } from '../types/database'

interface CallOpts<T> {
  body: Record<string, unknown>
  expect?: (body: unknown) => T
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
  const token = await ensureFreshAuthSession()

  const url = (import.meta.env.VITE_SUPABASE_URL as string) + '/functions/v1/broker-metatrader'
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify(opts.body),
  })

  const text = await res.text()
  let body: unknown = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>))
      ? String((body as Record<string, unknown>).error)
      : text || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return (opts.expect ? opts.expect(body) : (body as T))
}

export interface RegisterArgs {
  platform: 'MT4' | 'MT5'
  server: string
  login: string
  password: string
  label?: string
  signal_channel_ids?: string[]
}

export interface AccountSummary {
  balance?: number
  equity?: number
  currency?: string
  margin?: number
  freeMargin?: number
  marginLevel?: number
  leverage?: number
  /** Floating P/L across open positions, as reported by MT. */
  profit?: number
  credit?: number
  /** MT account trade mode label or code (e.g. ACCOUNT_TRADE_MODE_DEMO). */
  type?: string
}

export const metatraderApi = {
  register(args: RegisterArgs): Promise<{ broker: BrokerAccount; summary: AccountSummary | null }> {
    return call({
      body: { action: 'register', ...args },
      expect: (b) => b as { broker: BrokerAccount; summary: AccountSummary | null },
    })
  },

  remove(brokerId: string): Promise<{ ok: true }> {
    return call({
      body: { action: 'delete', broker_id: brokerId },
      expect: (b) => b as { ok: true },
    })
  },

  summary(
    brokerId: string,
    opts?: { calendarDay?: string; timezoneOffsetMinutes?: number },
  ): Promise<{
    summary: AccountSummary
    open_positions: number | null
    performance_baseline_balance?: number | null
    day_start_balance?: number | null
    day_start_balance_on?: string | null
    todays_profit_from_balance?: number | null
    /** True when balance is cached because live AccountSummary failed. */
    stale?: boolean
  }> {
    return call({
      body: {
        action: 'summary',
        broker_id: brokerId,
        ...(opts?.calendarDay ? { calendar_day: opts.calendarDay } : {}),
        ...(opts?.timezoneOffsetMinutes != null
          ? { timezone_offset_minutes: opts.timezoneOffsetMinutes }
          : {}),
      },
      expect: (b) =>
        b as {
          summary: AccountSummary
          open_positions: number | null
          performance_baseline_balance?: number | null
          day_start_balance?: number | null
          day_start_balance_on?: string | null
          todays_profit_from_balance?: number | null
          stale?: boolean
        },
    })
  },

  check(brokerId: string): Promise<{ result: string }> {
    return call({
      body: { action: 'check', broker_id: brokerId },
      expect: (b) => b as { result: string },
    })
  },

  reconnect(brokerId: string, password?: string): Promise<{
    ok: boolean
    connection_status: 'connected' | 'error'
    message?: string
    summary?: AccountSummary | null
  }> {
    return call({
      body: {
        action: 'reconnect',
        broker_id: brokerId,
        ...(password?.trim() ? { password: password.trim() } : {}),
      },
      expect: (b) =>
        b as {
          ok: boolean
          connection_status: 'connected' | 'error'
          message?: string
          summary?: AccountSummary | null
        },
    })
  },

  trades(args: {
    brokerId?: string
    scope?: 'all' | 'open' | 'closed'
    /** OrderHistory range (yyyy-MM-ddTHH:mm:ss). Defaults: last 90 days → now. */
    historyFrom?: string
    historyTo?: string
    /**
     * `dashboard` — charts / Today's profit (position-level merge, no deal-internal flatten).
     * `trades` — Account Trades page (deal-level rows + nested profit/lots).
     */
    historyProfile?: 'dashboard' | 'trades'
  } = {}): Promise<{ trades: MtTrade[]; debug?: { raw_sample_keys: string[]; raw_sample: Record<string, unknown> } }> {
    return call({
      body: {
        action: 'trades',
        broker_id: args.brokerId ?? '',
        scope: args.scope ?? 'all',
        history_profile: args.historyProfile ?? 'dashboard',
        ...(args.historyFrom ? { history_from: args.historyFrom } : {}),
        ...(args.historyTo ? { history_to: args.historyTo } : {}),
      },
      expect: (b) => b as { trades: MtTrade[]; debug?: { raw_sample_keys: string[]; raw_sample: Record<string, unknown> } },
    })
  },
}

export interface MtTrade {
  id: string
  broker_id: string
  broker_label: string
  broker_name: string | null
  ticket: number
  symbol: string
  /** Normalized direction. 'buy' or 'sell' for tradeable orders, '' for non-trade entries (e.g. balance). */
  direction: 'buy' | 'sell' | ''
  /** Human-readable order type label, e.g. 'Buy', 'Sell', 'Buy Limit', 'Sell Stop', 'Balance'. */
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
