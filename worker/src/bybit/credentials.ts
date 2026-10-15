import { createClient } from '@supabase/supabase-js'
import { decryptMtPassword } from '../brokerCredentialsCrypto'
import type { BybitCredential } from './client'

export const BYBIT_KEYS_UNREADABLE = 'Bybit API key could not be read'

const COLUMNS = [
  'bybit_account_id',
  'bybit_environment',
  'bybit_api_key_encrypted',
  'bybit_api_secret_encrypted',
  'bybit_margin_usdt',
  'bybit_leverage',
].join(',')

function serviceClient() {
  const url = String(process.env.SUPABASE_URL ?? '').trim()
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return createClient(url, key)
}

export function readBybitCredentialRow(accountId: string, row: Record<string, unknown>): BybitCredential {
  const apiKey = decryptMtPassword(row.bybit_api_key_encrypted as string | null | undefined)
  const apiSecret = decryptMtPassword(row.bybit_api_secret_encrypted as string | null | undefined)
  if (!apiKey || !apiSecret) throw new Error(BYBIT_KEYS_UNREADABLE)
  const leverage = Math.round(Number(row.bybit_leverage))
  const margin = Number(row.bybit_margin_usdt)
  return {
    accountId,
    environment: String(row.bybit_environment ?? '').trim().toLowerCase() === 'live' ? 'live' : 'demo',
    apiKey,
    apiSecret,
    marginUsdt: Number.isFinite(margin) && margin > 0 ? margin : 0,
    leverage: Number.isFinite(leverage) && leverage >= 1 ? Math.min(125, leverage) : 1,
  }
}

export async function loadBybitCredential(accountId: string): Promise<BybitCredential | null> {
  const supabase = serviceClient()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('broker_accounts')
    .select(COLUMNS)
    .eq('provider', 'bybit')
    .eq('bybit_account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return readBybitCredentialRow(accountId, data as unknown as Record<string, unknown>)
}
