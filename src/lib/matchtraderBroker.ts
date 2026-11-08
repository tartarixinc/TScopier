import type { BrokerAccount } from '../types/database'
import { ensureFreshAuthSession, refreshAuthTokenSingleFlight } from './fxsocketBroker'
import type { FxsocketMtStatus } from './fxsocketMtStatus'

export interface MatchtraderLoginDraft {
  /** The broker's Match-Trader platform URL, for example https://trade.yourbroker.com. */
  serverUrl: string
  email: string
  password: string
  /** Optional account number, needed only when the login holds several accounts. */
  accountId: string
  /** Optional broker id. Normally discovered from the platform URL. */
  brokerId: string
  label: string
}

export const DEFAULT_MATCHTRADER_DRAFT: MatchtraderLoginDraft = {
  serverUrl: '',
  email: '',
  password: '',
  accountId: '',
  brokerId: '',
  label: '',
}

export type MatchtraderDraftError = 'serverUrl' | 'email' | 'password' | 'accountId' | 'brokerId'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Returns the https URL with only its host kept, or null when it is not a usable public URL. */
export function normalizeMatchtraderServerUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw || raw.length > 200) return null
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null
  if (parsed.port && parsed.port !== '443') return null
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.') || host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null
  return `https://${host}`
}

export function parseMatchtraderDraft(
  draft: MatchtraderLoginDraft,
): {
  ok: true
  login: { serverUrl: string; email: string; password: string; accountId: string; brokerId: string; label: string }
} | { ok: false; field: MatchtraderDraftError } {
  const serverUrl = normalizeMatchtraderServerUrl(draft.serverUrl)
  if (!serverUrl) return { ok: false, field: 'serverUrl' }
  const email = draft.email.trim()
  if (!EMAIL_PATTERN.test(email) || email.length > 200) return { ok: false, field: 'email' }
  if (!draft.password || draft.password.length > 256) return { ok: false, field: 'password' }
  const accountId = draft.accountId.trim().replace(/^#/, '')
  if (accountId && !/^[A-Za-z0-9-]{1,100}$/.test(accountId)) return { ok: false, field: 'accountId' }
  const brokerId = draft.brokerId.trim()
  if (brokerId && !/^[A-Za-z0-9_-]{1,64}$/.test(brokerId)) return { ok: false, field: 'brokerId' }
  return {
    ok: true,
    login: { serverUrl, email, password: draft.password, accountId, brokerId, label: draft.label.trim() },
  }
}

async function callMatchtrader<T>(body: Record<string, unknown>, expect: (payload: unknown) => T): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/matchtrader-broker`
  const doFetch = async (token: string) => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify(body),
  })

  let token = await ensureFreshAuthSession()
  let response = await doFetch(token)
  if (response.status === 401) {
    const retry = await refreshAuthTokenSingleFlight()
    if (retry && retry !== token) {
      token = retry
      response = await doFetch(token)
    }
  }
  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try { payload = JSON.parse(text) } catch { payload = text }
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error)
      : text || `HTTP ${response.status}`
    throw new Error(message)
  }
  return expect(payload)
}

export function linkMatchtraderAccount(args: {
  serverUrl: string
  email: string
  password: string
  accountId?: string
  brokerId?: string
  label?: string
}): Promise<{ account: BrokerAccount; status?: FxsocketMtStatus }> {
  return callMatchtrader({
    action: 'link',
    server_url: args.serverUrl.trim(),
    email: args.email.trim(),
    password: args.password,
    account_id_ref: args.accountId?.trim() || undefined,
    broker_id: args.brokerId?.trim() || undefined,
    label: args.label?.trim() || undefined,
  }, payload => {
    const row = payload as { account?: BrokerAccount; status?: FxsocketMtStatus }
    if (!row.account) throw new Error('Match-Trader did not link an account')
    return { account: row.account, status: row.status }
  })
}
