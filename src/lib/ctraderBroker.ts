import type { BrokerAccount } from '../types/database'
import { ensureFreshAuthSession, refreshAuthTokenSingleFlight } from './fxsocketBroker'
import type { FxsocketMtStatus } from './fxsocketMtStatus'

export interface CtraderAccountChoice {
  accountId: string
  accountNumber: string | null
  brokerName: string | null
  live: boolean
  environment: 'demo' | 'live'
}

function ctraderRedirectUri(): string {
  return `${window.location.origin}/brokers/ctrader/callback`
}

async function callCtrader<T>(body: Record<string, unknown>, expect: (payload: unknown) => T): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/ctrader-broker`
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

export function startCtraderConnect(): Promise<{ authorizeUrl: string }> {
  return callCtrader({ action: 'start', redirect_uri: ctraderRedirectUri() }, payload => {
    const row = payload as { authorize_url?: string }
    const authorizeUrl = String(row.authorize_url ?? '').trim()
    if (!authorizeUrl) throw new Error('cTrader did not return a sign-in link')
    return { authorizeUrl }
  })
}

const exchangeInflight = new Map<string, Promise<{
  handoff: string
  accounts: CtraderAccountChoice[]
}>>()

/** One exchange per OAuth code. React remounts the callback once, and the code cannot be reused. */
export function exchangeCtraderCodeOnce(code: string, state: string): Promise<{
  handoff: string
  accounts: CtraderAccountChoice[]
}> {
  const existing = exchangeInflight.get(code)
  if (existing) return existing
  const pending = exchangeCtraderCode(code, state).catch(error => {
    exchangeInflight.delete(code)
    throw error
  })
  exchangeInflight.set(code, pending)
  return pending
}

export function exchangeCtraderCode(code: string, state: string): Promise<{
  handoff: string
  accounts: CtraderAccountChoice[]
}> {
  return callCtrader({
    action: 'exchange',
    code,
    state,
    redirect_uri: ctraderRedirectUri(),
  }, payload => {
    const row = payload as { handoff?: string; accounts?: CtraderAccountChoice[] }
    const handoff = String(row.handoff ?? '').trim()
    const accounts = Array.isArray(row.accounts) ? row.accounts : []
    if (!handoff || accounts.length === 0) throw new Error('No cTrader trading accounts were found')
    return { handoff, accounts }
  })
}

export function linkCtraderAccount(args: {
  handoff: string
  accountId: string
  label?: string
}): Promise<{ account: BrokerAccount; status?: FxsocketMtStatus }> {
  return callCtrader({
    action: 'link',
    handoff: args.handoff,
    account_id: args.accountId,
    label: args.label,
  }, payload => {
    const row = payload as { account?: BrokerAccount; status?: FxsocketMtStatus }
    if (!row.account) throw new Error('cTrader did not link an account')
    return { account: row.account, status: row.status }
  })
}
