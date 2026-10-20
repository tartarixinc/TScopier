import { createClient } from '@supabase/supabase-js'
import { decryptMtPassword } from '../brokerCredentialsCrypto'
import type { TradelockerCredential } from './client'

export const TRADELOCKER_LOGIN_UNREADABLE = 'TradeLocker login could not be read'

const COLUMNS = [
  'tradelocker_account_id',
  'tradelocker_environment',
  'tradelocker_server',
  'tradelocker_email',
  'tradelocker_password_encrypted',
  'tradelocker_account_ref',
  'tradelocker_acc_num',
].join(',')

function serviceClient() {
  const url = String(process.env.SUPABASE_URL ?? '').trim()
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return createClient(url, key)
}

export function readTradelockerCredentialRow(accountId: string, row: Record<string, unknown>): TradelockerCredential {
  const password = decryptMtPassword(row.tradelocker_password_encrypted as string | null | undefined)
  const email = String(row.tradelocker_email ?? '').trim()
  const server = String(row.tradelocker_server ?? '').trim()
  const tlAccountId = String(row.tradelocker_account_ref ?? '').trim()
  const accNum = Number(row.tradelocker_acc_num)
  const environment = row.tradelocker_environment
  if (!password || !email || !server || !tlAccountId || !Number.isFinite(accNum) || (environment !== 'demo' && environment !== 'live')) {
    throw new Error(TRADELOCKER_LOGIN_UNREADABLE)
  }
  return { accountId, environment, server, email, password, tlAccountId, accNum }
}

export async function loadTradelockerCredential(accountId: string): Promise<TradelockerCredential | null> {
  const supabase = serviceClient()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('broker_accounts')
    .select(COLUMNS)
    .eq('provider', 'tradelocker')
    .eq('tradelocker_account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return readTradelockerCredentialRow(accountId, data as unknown as Record<string, unknown>)
}
