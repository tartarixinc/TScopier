import { createClient } from '@supabase/supabase-js'
import { decryptMtPassword } from '../brokerCredentialsCrypto'
import type { BinanceFuturesCredential } from './futuresClient'

export const BINANCE_KEYS_UNREADABLE = 'Binance API key could not be read'

const COLUMNS = [
  'binance_account_id',
  'binance_environment',
  'binance_api_key_encrypted',
  'binance_api_secret_encrypted',
  'binance_margin_usdt',
  'binance_leverage',
  'binance_margin_mode',
].join(',')

function serviceClient() {
  const url = String(process.env.SUPABASE_URL ?? '').trim()
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return createClient(url, key)
}

export function readBinanceCredentialRow(accountId: string, row: Record<string, unknown>): BinanceFuturesCredential {
  const apiKey = decryptMtPassword(row.binance_api_key_encrypted as string | null | undefined)
  const apiSecret = decryptMtPassword(row.binance_api_secret_encrypted as string | null | undefined)
  if (!apiKey || !apiSecret) throw new Error(BINANCE_KEYS_UNREADABLE)
  const leverage = Math.round(Number(row.binance_leverage))
  const margin = Number(row.binance_margin_usdt)
  return {
    accountId,
    environment: String(row.binance_environment ?? '').trim().toLowerCase() === 'live' ? 'live' : 'demo',
    apiKey,
    apiSecret,
    marginUsdt: Number.isFinite(margin) && margin > 0 ? margin : 0,
    leverage: Number.isFinite(leverage) && leverage >= 1 ? Math.min(125, leverage) : 1,
    marginMode: String(row.binance_margin_mode ?? '').trim().toLowerCase() === 'cross' ? 'cross' : 'isolated',
  }
}

export async function loadBinanceCredential(accountId: string): Promise<BinanceFuturesCredential | null> {
  const supabase = serviceClient()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('broker_accounts')
    .select(COLUMNS)
    .eq('provider', 'binance')
    .eq('binance_account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return readBinanceCredentialRow(accountId, data as unknown as Record<string, unknown>)
}
