import type { BrokerAccount } from '../types/database'
import { ensureFreshAuthSession, refreshAuthTokenSingleFlight } from './fxsocketBroker'
import type { FxsocketMtStatus } from './fxsocketMtStatus'

export interface DxtradeLoginDraft {
  serverUrl: string
  username: string
  domain: string
  password: string
  accountCode: string
  label: string
}

export const DEFAULT_DXTRADE_DRAFT: DxtradeLoginDraft = {
  serverUrl: '',
  username: '',
  domain: 'default',
  password: '',
  accountCode: '',
  label: '',
}

export type DxtradeDraftError = 'server' | 'username' | 'password'

const BLOCKED_HOST_SUFFIXES = [
  '.local', '.localhost', '.internal', '.localdomain', '.lan', '.home', '.corp', '.intranet', '.private',
]

/**
 * Normalise what the trader pasted into `https://host/dxsca-web`. The edge function repeats these
 * checks (plus a DNS check); this is the early feedback.
 */
export function normalizeDxtradeServerUrl(input: string): { ok: true; url: string } | { ok: false } {
  const raw = input.trim()
  if (!raw) return { ok: false }
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false }
  }
  if (parsed.protocol !== 'https:') return { ok: false }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return { ok: false }
  if (parsed.port && parsed.port !== '443') return { ok: false }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false }
  if (!host.includes('.') || host === 'localhost' || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return { ok: false }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return { ok: false }
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path !== '' && path.toLowerCase() !== '/dxsca-web') return { ok: false }
  return { ok: true, url: `https://${host}/dxsca-web` }
}

export function parseDxtradeDraft(
  draft: DxtradeLoginDraft,
): { ok: true; login: { serverUrl: string; username: string; domain: string; password: string; accountCode: string; label: string } }
  | { ok: false; field: DxtradeDraftError } {
  const server = normalizeDxtradeServerUrl(draft.serverUrl)
  if (!server.ok) return { ok: false, field: 'server' }
  const username = draft.username.trim()
  if (!username || username.includes('@')) return { ok: false, field: 'username' }
  if (!draft.password) return { ok: false, field: 'password' }
  return {
    ok: true,
    login: {
      serverUrl: server.url,
      username,
      domain: draft.domain.trim() || 'default',
      password: draft.password,
      accountCode: draft.accountCode.trim(),
      label: draft.label.trim(),
    },
  }
}

async function callDxtrade<T>(body: Record<string, unknown>, expect: (payload: unknown) => T): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/dxtrade-broker`
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

export function linkDxtradeAccount(args: {
  serverUrl: string
  username: string
  domain: string
  password: string
  accountCode?: string
  label?: string
}): Promise<{ account: BrokerAccount; status?: FxsocketMtStatus }> {
  return callDxtrade({
    action: 'link',
    server_url: args.serverUrl.trim(),
    username: args.username.trim(),
    domain: args.domain.trim() || 'default',
    password: args.password,
    account_code: args.accountCode?.trim() || undefined,
    label: args.label?.trim() || undefined,
  }, payload => {
    const row = payload as { account?: BrokerAccount; status?: FxsocketMtStatus }
    if (!row.account) throw new Error('DXtrade did not link an account')
    return { account: row.account, status: row.status }
  })
}
