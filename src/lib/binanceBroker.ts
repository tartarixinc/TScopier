import type { BrokerAccount } from '../types/database'
import { ensureFreshAuthSession, refreshAuthTokenSingleFlight } from './fxsocketBroker'
import type { FxsocketMtStatus } from './fxsocketMtStatus'

export type BinanceEnvironment = 'demo' | 'live'
export type BinanceMarginMode = 'isolated' | 'cross'

export interface BinanceTradingSettings {
  marginUsdt: number
  leverage: number
  marginMode: BinanceMarginMode
}

export interface BinanceSettingsDraft {
  marginUsdt: string
  leverage: string
  marginMode: BinanceMarginMode
}

export const BINANCE_MAX_LEVERAGE = 125
export const BINANCE_MAX_MARGIN_USDT = 10_000_000

export const DEFAULT_BINANCE_SETTINGS_DRAFT: BinanceSettingsDraft = {
  marginUsdt: '100',
  leverage: '10',
  marginMode: 'isolated',
}

export type BinanceSettingsError = 'margin' | 'leverage' | 'mode'

/** Parse the form draft into server settings, or name the first invalid field. */
export function parseBinanceSettingsDraft(
  draft: BinanceSettingsDraft,
): { ok: true; settings: BinanceTradingSettings } | { ok: false; field: BinanceSettingsError } {
  const marginUsdt = Number(draft.marginUsdt.trim())
  if (!Number.isFinite(marginUsdt) || marginUsdt <= 0 || marginUsdt > BINANCE_MAX_MARGIN_USDT) {
    return { ok: false, field: 'margin' }
  }
  const leverage = Number(draft.leverage.trim())
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > BINANCE_MAX_LEVERAGE) {
    return { ok: false, field: 'leverage' }
  }
  if (draft.marginMode !== 'isolated' && draft.marginMode !== 'cross') {
    return { ok: false, field: 'mode' }
  }
  return { ok: true, settings: { marginUsdt, leverage, marginMode: draft.marginMode } }
}

/** Seed the editor from a broker row (non-secret columns only). */
export function binanceSettingsDraftFromBroker(
  broker: Pick<BrokerAccount, 'binance_margin_usdt' | 'binance_leverage' | 'binance_margin_mode'>,
): BinanceSettingsDraft {
  return {
    marginUsdt: broker.binance_margin_usdt != null
      ? String(broker.binance_margin_usdt)
      : DEFAULT_BINANCE_SETTINGS_DRAFT.marginUsdt,
    leverage: broker.binance_leverage != null
      ? String(broker.binance_leverage)
      : DEFAULT_BINANCE_SETTINGS_DRAFT.leverage,
    marginMode: broker.binance_margin_mode === 'cross' ? 'cross' : 'isolated',
  }
}

async function callBinance<T>(body: Record<string, unknown>, expect: (payload: unknown) => T): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/binance-broker`
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

export function linkBinanceAccount(args: {
  apiKey: string
  apiSecret: string
  environment: BinanceEnvironment
  label?: string
  settings: BinanceTradingSettings
}): Promise<{ account: BrokerAccount; status?: FxsocketMtStatus }> {
  return callBinance({
    action: 'link',
    api_key: args.apiKey.trim(),
    api_secret: args.apiSecret.trim(),
    environment: args.environment,
    label: args.label?.trim() || undefined,
    margin_usdt: args.settings.marginUsdt,
    leverage: args.settings.leverage,
    margin_mode: args.settings.marginMode,
  }, payload => {
    const row = payload as { account?: BrokerAccount; status?: FxsocketMtStatus }
    if (!row.account) throw new Error('Binance did not link an account')
    return { account: row.account, status: row.status }
  })
}

export function updateBinanceSettings(
  accountId: string,
  settings: BinanceTradingSettings,
): Promise<BrokerAccount> {
  return callBinance({
    action: 'update_settings',
    account_id: accountId,
    margin_usdt: settings.marginUsdt,
    leverage: settings.leverage,
    margin_mode: settings.marginMode,
  }, payload => {
    const row = payload as { account?: BrokerAccount }
    if (!row.account) throw new Error('Binance did not return the updated account')
    return row.account
  })
}
