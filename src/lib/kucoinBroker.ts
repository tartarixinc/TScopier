import type { BrokerAccount } from '../types/database'
import { ensureFreshAuthSession, refreshAuthTokenSingleFlight } from './fxsocketBroker'
import type { FxsocketMtStatus } from './fxsocketMtStatus'

export type KucoinMarginMode = 'isolated' | 'cross'

/** Where users create API keys. */
export const KUCOIN_API_MANAGEMENT_URL = 'https://www.kucoin.com/account/api'

export interface KucoinTradingSettings {
  marginUsdt: number
  leverage: number
  marginMode: KucoinMarginMode
}

export interface KucoinSettingsDraft {
  marginUsdt: string
  leverage: string
  marginMode: KucoinMarginMode
}

export const KUCOIN_MAX_LEVERAGE = 125
export const KUCOIN_MAX_MARGIN_USDT = 10_000_000

export const DEFAULT_KUCOIN_SETTINGS_DRAFT: KucoinSettingsDraft = {
  marginUsdt: '100',
  leverage: '10',
  marginMode: 'isolated',
}

export type KucoinSettingsError = 'margin' | 'leverage' | 'mode'

/** Parse the form draft into server settings, or name the first invalid field. */
export function parseKucoinSettingsDraft(
  draft: KucoinSettingsDraft,
): { ok: true; settings: KucoinTradingSettings } | { ok: false; field: KucoinSettingsError } {
  const marginUsdt = Number(draft.marginUsdt.trim())
  if (!Number.isFinite(marginUsdt) || marginUsdt <= 0 || marginUsdt > KUCOIN_MAX_MARGIN_USDT) {
    return { ok: false, field: 'margin' }
  }
  const leverage = Number(draft.leverage.trim())
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > KUCOIN_MAX_LEVERAGE) {
    return { ok: false, field: 'leverage' }
  }
  if (draft.marginMode !== 'isolated' && draft.marginMode !== 'cross') {
    return { ok: false, field: 'mode' }
  }
  return { ok: true, settings: { marginUsdt, leverage, marginMode: draft.marginMode } }
}

/** Seed the editor from a broker row (non-secret columns only). */
export function kucoinSettingsDraftFromBroker(
  broker: Pick<BrokerAccount, 'kucoin_margin_usdt' | 'kucoin_leverage' | 'kucoin_margin_mode'>,
): KucoinSettingsDraft {
  return {
    marginUsdt: broker.kucoin_margin_usdt != null
      ? String(broker.kucoin_margin_usdt)
      : DEFAULT_KUCOIN_SETTINGS_DRAFT.marginUsdt,
    leverage: broker.kucoin_leverage != null
      ? String(broker.kucoin_leverage)
      : DEFAULT_KUCOIN_SETTINGS_DRAFT.leverage,
    marginMode: broker.kucoin_margin_mode === 'cross' ? 'cross' : 'isolated',
  }
}

async function callKucoin<T>(body: Record<string, unknown>, expect: (payload: unknown) => T): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/kucoin-broker`
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

export function linkKucoinAccount(args: {
  apiKey: string
  apiSecret: string
  passphrase: string
  label?: string
  settings: KucoinTradingSettings
}): Promise<{ account: BrokerAccount; status?: FxsocketMtStatus }> {
  return callKucoin({
    action: 'link',
    api_key: args.apiKey.trim(),
    api_secret: args.apiSecret.trim(),
    passphrase: args.passphrase.trim(),
    label: args.label?.trim() || undefined,
    margin_usdt: args.settings.marginUsdt,
    leverage: args.settings.leverage,
    margin_mode: args.settings.marginMode,
  }, payload => {
    const row = payload as { account?: BrokerAccount; status?: FxsocketMtStatus }
    if (!row.account) throw new Error('Kucoin did not link an account')
    return { account: row.account, status: row.status }
  })
}

export function updateKucoinSettings(
  accountId: string,
  settings: KucoinTradingSettings,
): Promise<BrokerAccount> {
  return callKucoin({
    action: 'update_settings',
    account_id: accountId,
    margin_usdt: settings.marginUsdt,
    leverage: settings.leverage,
    margin_mode: settings.marginMode,
  }, payload => {
    const row = payload as { account?: BrokerAccount }
    if (!row.account) throw new Error('Kucoin did not return the updated account')
    return row.account
  })
}
