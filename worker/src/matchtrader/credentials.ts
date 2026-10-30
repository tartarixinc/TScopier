import { createClient } from '@supabase/supabase-js'
import { decryptMtPassword } from '../brokerCredentialsCrypto'
import type { MatchtraderCredential } from './client'
import { normalizeMatchtraderUrl } from './urlSafety'
import { tagKey, type TagEntry } from './symbols'

export const MATCHTRADER_LOGIN_UNREADABLE = 'Match-Trader login could not be read'

const COLUMNS = [
  'id',
  'matchtrader_account_id',
  'matchtrader_server_url',
  'matchtrader_broker_id',
  'matchtrader_email',
  'matchtrader_password_encrypted',
  'matchtrader_trading_account_uuid',
  'matchtrader_system_uuid',
].join(',')

function serviceClient() {
  const url = String(process.env.SUPABASE_URL ?? '').trim()
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return createClient(url, key)
}

export function readMatchtraderCredentialRow(accountId: string, row: Record<string, unknown>): MatchtraderCredential {
  const password = decryptMtPassword(row.matchtrader_password_encrypted as string | null | undefined)
  const email = String(row.matchtrader_email ?? '').trim()
  const brokerId = String(row.matchtrader_broker_id ?? '').trim()
  const tradingAccountUuid = String(row.matchtrader_trading_account_uuid ?? '').trim()
  const systemUuid = String(row.matchtrader_system_uuid ?? '').trim()
  const url = normalizeMatchtraderUrl(String(row.matchtrader_server_url ?? ''))
  if (!password || !email || !brokerId || !tradingAccountUuid || !systemUuid || !url.ok) {
    throw new Error(MATCHTRADER_LOGIN_UNREADABLE)
  }
  return {
    accountId,
    brokerAccountId: String(row.id ?? '').trim(),
    serverUrl: url.url,
    brokerId,
    email,
    password,
    tradingAccountUuid,
    systemUuid,
  }
}

export async function loadMatchtraderCredential(accountId: string): Promise<MatchtraderCredential | null> {
  const supabase = serviceClient()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('broker_accounts')
    .select(COLUMNS)
    .eq('provider', 'matchtrader')
    .eq('matchtrader_account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return readMatchtraderCredentialRow(accountId, data as unknown as Record<string, unknown>)
}

/**
 * Where the comment of each opened order lives. Match-Trader writes have no comment field, so the
 * provider stores it per order id (table `matchtrader_order_tags`, service-role only).
 */
export interface MatchtraderTagStore {
  load(brokerAccountId: string): Promise<Map<string, TagEntry>>
  put(brokerAccountId: string, orderId: string, entry: TagEntry): Promise<void>
}

export const supabaseTagStore: MatchtraderTagStore = {
  async load(brokerAccountId) {
    const out = new Map<string, TagEntry>()
    const supabase = serviceClient()
    if (!supabase || !brokerAccountId) return out
    const { data, error } = await supabase
      .from('matchtrader_order_tags')
      .select('order_id,comment,symbol,side,created_at')
      .eq('broker_account_id', brokerAccountId)
      .order('created_at', { ascending: false })
      .limit(2000)
    if (error) throw new Error(error.message)
    for (const row of data ?? []) {
      const key = tagKey(row.order_id)
      if (!key || out.has(key)) continue
      const side = String(row.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy'
      out.set(key, {
        comment: String(row.comment ?? ''),
        symbol: String(row.symbol ?? ''),
        side,
        at: Date.parse(String(row.created_at ?? '')) || 0,
      })
    }
    return out
  },
  async put(brokerAccountId, orderId, entry) {
    const supabase = serviceClient()
    if (!supabase || !brokerAccountId) return
    const { error } = await supabase.from('matchtrader_order_tags').upsert({
      broker_account_id: brokerAccountId,
      order_id: orderId,
      comment: entry.comment,
      symbol: entry.symbol,
      side: entry.side,
      created_at: new Date(entry.at).toISOString(),
    }, { onConflict: 'broker_account_id,order_id' })
    if (error) throw new Error(error.message)
  },
}
