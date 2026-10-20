import type { BrokerAccount } from '../types/database'
import { ensureFreshAuthSession, refreshAuthTokenSingleFlight } from './fxsocketBroker'
import type { FxsocketMtStatus } from './fxsocketMtStatus'

export type TradelockerEnvironment = 'demo' | 'live'

export interface TradelockerLoginDraft {
  environment: TradelockerEnvironment
  server: string
  email: string
  password: string
  /** Optional account number, needed only when the login holds several accounts. */
  accountId: string
  label: string
}

export const DEFAULT_TRADELOCKER_DRAFT: TradelockerLoginDraft = {
  environment: 'demo',
  server: '',
  email: '',
  password: '',
  accountId: '',
  label: '',
}

export type TradelockerDraftError = 'server' | 'email' | 'password' | 'accountId'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseTradelockerDraft(
  draft: TradelockerLoginDraft,
): {
  ok: true
  login: { environment: TradelockerEnvironment; server: string; email: string; password: string; accountId: string; label: string }
} | { ok: false; field: TradelockerDraftError } {
  const server = draft.server.trim()
  // eslint-disable-next-line no-control-regex -- control characters are never valid in a server name
  if (!server || server.length > 100 || /[\u0000-\u001f\u007f]/.test(server)) return { ok: false, field: 'server' }
  const email = draft.email.trim()
  if (!EMAIL_PATTERN.test(email) || email.length > 200) return { ok: false, field: 'email' }
  if (!draft.password || draft.password.length > 256) return { ok: false, field: 'password' }
  const accountId = draft.accountId.trim().replace(/^#/, '')
  if (accountId && !/^\d{1,20}$/.test(accountId)) return { ok: false, field: 'accountId' }
  return {
    ok: true,
    login: {
      environment: draft.environment === 'live' ? 'live' : 'demo',
      server,
      email,
      password: draft.password,
      accountId,
      label: draft.label.trim(),
    },
  }
}

async function callTradelocker<T>(body: Record<string, unknown>, expect: (payload: unknown) => T): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/tradelocker-broker`
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

export function linkTradelockerAccount(args: {
  environment: TradelockerEnvironment
  server: string
  email: string
  password: string
  accountId?: string
  label?: string
}): Promise<{ account: BrokerAccount; status?: FxsocketMtStatus }> {
  return callTradelocker({
    action: 'link',
    environment: args.environment,
    server: args.server.trim(),
    email: args.email.trim(),
    password: args.password,
    account_id_ref: args.accountId?.trim() || undefined,
    label: args.label?.trim() || undefined,
  }, payload => {
    const row = payload as { account?: BrokerAccount; status?: FxsocketMtStatus }
    if (!row.account) throw new Error('TradeLocker did not link an account')
    return { account: row.account, status: row.status }
  })
}
