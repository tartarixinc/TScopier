import { createClient } from '@supabase/supabase-js'
import { decryptMtPassword } from '../brokerCredentialsCrypto'
import type { KucoinCredential } from './client'

export const KUCOIN_KEYS_UNREADABLE = 'KuCoin API key could not be read'

const COLUMNS = [
  'kucoin_account_id',
  'kucoin_api_key_encrypted',
  'kucoin_api_secret_encrypted',
  'kucoin_passphrase_encrypted',
  'kucoin_margin_usdt',
  'kucoin_leverage',
  'kucoin_margin_mode',
].join(',')

function serviceClient() {
  const url = String(process.env.SUPABASE_URL ?? '').trim()
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return createClient(url, key)
}

export function readKucoinCredentialRow(accountId: string, row: Record<string, unknown>): KucoinCredential {
  const apiKey = decryptMtPassword(row.kucoin_api_key_encrypted as string | null | undefined)
  const apiSecret = decryptMtPassword(row.kucoin_api_secret_encrypted as string | null | undefined)
  const passphrase = decryptMtPassword(row.kucoin_passphrase_encrypted as string | null | undefined)
  if (!apiKey || !apiSecret || !passphrase) throw new Error(KUCOIN_KEYS_UNREADABLE)
  const leverage = Math.round(Number(row.kucoin_leverage))
  const margin = Number(row.kucoin_margin_usdt)
  return {
    accountId,
    apiKey,
    apiSecret,
    passphrase,
    marginUsdt: Number.isFinite(margin) && margin > 0 ? margin : 0,
    leverage: Number.isFinite(leverage) && leverage >= 1 ? Math.min(125, leverage) : 1,
    marginMode: String(row.kucoin_margin_mode ?? '').trim().toLowerCase() === 'cross' ? 'cross' : 'isolated',
  }
}

export async function loadKucoinCredential(accountId: string): Promise<KucoinCredential | null> {
  const supabase = serviceClient()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('broker_accounts')
    .select(COLUMNS)
    .eq('provider', 'kucoin')
    .eq('kucoin_account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return readKucoinCredentialRow(accountId, data as unknown as Record<string, unknown>)
}
