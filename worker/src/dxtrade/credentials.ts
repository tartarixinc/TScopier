import { createClient } from '@supabase/supabase-js'
import { decryptMtPassword } from '../brokerCredentialsCrypto'
import type { DxtradeCredential } from './client'

export const DXTRADE_LOGIN_UNREADABLE = 'DXtrade login could not be read'

const COLUMNS = [
  'dxtrade_account_id',
  'dxtrade_server_url',
  'dxtrade_username',
  'dxtrade_domain',
  'dxtrade_password_encrypted',
  'dxtrade_account_code',
  'dxtrade_is_position_based',
].join(',')

function serviceClient() {
  const url = String(process.env.SUPABASE_URL ?? '').trim()
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return createClient(url, key)
}

export function readDxtradeCredentialRow(accountId: string, row: Record<string, unknown>): DxtradeCredential {
  const password = decryptMtPassword(row.dxtrade_password_encrypted as string | null | undefined)
  const username = String(row.dxtrade_username ?? '').trim()
  const serverUrl = String(row.dxtrade_server_url ?? '').trim()
  const accountCode = String(row.dxtrade_account_code ?? '').trim()
  if (!password || !username || !serverUrl || !accountCode) throw new Error(DXTRADE_LOGIN_UNREADABLE)
  return {
    accountId,
    serverUrl,
    username,
    domain: String(row.dxtrade_domain ?? '').trim() || 'default',
    password,
    accountCode,
    isPositionBased: row.dxtrade_is_position_based === true,
  }
}

export async function loadDxtradeCredential(accountId: string): Promise<DxtradeCredential | null> {
  const supabase = serviceClient()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('broker_accounts')
    .select(COLUMNS)
    .eq('provider', 'dxtrade')
    .eq('dxtrade_account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return readDxtradeCredentialRow(accountId, data as unknown as Record<string, unknown>)
}
