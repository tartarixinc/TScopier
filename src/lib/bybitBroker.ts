import type { BrokerAccount } from '../types/database'
import { ensureFreshAuthSession, refreshAuthTokenSingleFlight } from './fxsocketBroker'
import type { FxsocketMtStatus } from './fxsocketMtStatus'

export type BybitEnvironment = 'demo' | 'live'

/**
 * Margin mode lives on the Bybit account (Unified accounts share one mode for every
 * symbol). The app reads and shows it but never sets it.
 */
export type BybitMarginModeKind = 'isolated' | 'cross' | 'portfolio'

export interface BybitTradingSettings {
  marginUsdt: number
  leverage: number
}

export interface BybitSettingsDraft {
  marginUsdt: string
  leverage: string
}

export const BYBIT_MAX_LEVERAGE = 125
export const BYBIT_MAX_MARGIN_USDT = 10_000_000

export const DEFAULT_BYBIT_SETTINGS_DRAFT: BybitSettingsDraft = {
  marginUsdt: '100',
  leverage: '10',
}

export type BybitSettingsError = 'margin' | 'leverage'

/** Parse the form draft into server settings, or name the first invalid field. */
export function parseBybitSettingsDraft(
  draft: BybitSettingsDraft,
): { ok: true; settings: BybitTradingSettings } | { ok: false; field: BybitSettingsError } {
  const marginUsdt = Number(draft.marginUsdt.trim())
  if (!Number.isFinite(marginUsdt) || marginUsdt <= 0 || marginUsdt > BYBIT_MAX_MARGIN_USDT) {
    return { ok: false, field: 'margin' }
  }
  const leverage = Number(draft.leverage.trim())
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > BYBIT_MAX_LEVERAGE) {
    return { ok: false, field: 'leverage' }
  }
  return { ok: true, settings: { marginUsdt, leverage } }
}

/** Seed the editor from a broker row (non-secret columns only). */
export function bybitSettingsDraftFromBroker(
  broker: Pick<BrokerAccount, 'bybit_margin_usdt' | 'bybit_leverage'>,
): BybitSettingsDraft {
  return {
    marginUsdt: broker.bybit_margin_usdt != null
      ? String(broker.bybit_margin_usdt)
      : DEFAULT_BYBIT_SETTINGS_DRAFT.marginUsdt,
    leverage: broker.bybit_leverage != null
      ? String(broker.bybit_leverage)
      : DEFAULT_BYBIT_SETTINGS_DRAFT.leverage,
  }
}

/** Map Bybit's `marginMode` string onto a display kind. Unknown values return null. */
export function bybitMarginModeKind(mode: string | null | undefined): BybitMarginModeKind | null {
  switch (String(mode ?? '').trim().toUpperCase()) {
    case 'ISOLATED_MARGIN':
      return 'isolated'
    case 'REGULAR_MARGIN':
      return 'cross'
    case 'PORTFOLIO_MARGIN':
      return 'portfolio'
    default:
      return null
  }
}

async function callBybit<T>(body: Record<string, unknown>, expect: (payload: unknown) => T): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/bybit-broker`
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

export function linkBybitAccount(args: {
  apiKey: string
  apiSecret: string
  environment: BybitEnvironment
  label?: string
  settings: BybitTradingSettings
}): Promise<{ account: BrokerAccount; status?: FxsocketMtStatus }> {
  return callBybit({
    action: 'link',
    api_key: args.apiKey.trim(),
    api_secret: args.apiSecret.trim(),
    environment: args.environment,
    label: args.label?.trim() || undefined,
    margin_usdt: args.settings.marginUsdt,
    leverage: args.settings.leverage,
  }, payload => {
    const row = payload as { account?: BrokerAccount; status?: FxsocketMtStatus }
    if (!row.account) throw new Error('Bybit did not link an account')
    return { account: row.account, status: row.status }
  })
}

export function updateBybitSettings(
  accountId: string,
  settings: BybitTradingSettings,
): Promise<BrokerAccount> {
  return callBybit({
    action: 'update_settings',
    account_id: accountId,
    margin_usdt: settings.marginUsdt,
    leverage: settings.leverage,
  }, payload => {
    const row = payload as { account?: BrokerAccount }
    if (!row.account) throw new Error('Bybit did not return the updated account')
    return row.account
  })
}
