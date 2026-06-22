import { createClient } from '@supabase/supabase-js'
import { mtPlatformFrom } from '../fxsocketClient'
import { brokerSessionId } from '../mtApiByAccount'

export type WsLoadAccount = {
  accountId: string
  platform: 'MT4' | 'MT5'
}

export type WsLoadAccountSource = 'mock' | 'env' | 'supabase'

export type ResolvedWsLoadAccounts = {
  accounts: WsLoadAccount[]
  source: WsLoadAccountSource
}

const MOCK_WS_SOFT_CAP = Math.max(
  100,
  Number(process.env.LOAD_WS_MOCK_MAX_ACCOUNTS ?? 500) || 500,
)

export function mockWsSoftCap(): number {
  return MOCK_WS_SOFT_CAP
}

function parseEnvAccountIds(): WsLoadAccount[] {
  const raw = (process.env.LOAD_WS_ACCOUNT_IDS ?? '').trim()
  if (!raw) return []
  const platformDefault = (process.env.LOAD_WS_PLATFORM ?? 'MT5').toUpperCase() === 'MT4' ? 'MT4' : 'MT5'
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, platformRaw] = entry.split(':').map(s => s.trim())
      const platform = platformRaw?.toUpperCase() === 'MT4' ? 'MT4' : platformDefault
      return { accountId: id!, platform }
    })
}

async function fetchLinkedAccountsFromSupabase(limit: number): Promise<WsLoadAccount[]> {
  const url = process.env.SUPABASE_URL ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (!url || !key) return []

  const supabase = createClient(url, key)
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('fxsocket_account_id,metaapi_account_id,platform,is_active')
    .eq('is_active', true)
    .limit(Math.max(limit, 50))

  if (error) {
    console.warn(`[ws-load] broker_accounts lookup failed: ${error.message}`)
    return []
  }

  const accounts: WsLoadAccount[] = []
  for (const row of data ?? []) {
    const accountId = brokerSessionId(row as { fxsocket_account_id?: string; metaapi_account_id?: string })
    if (!accountId) continue
    accounts.push({
      accountId,
      platform: mtPlatformFrom((row as { platform?: string | null }).platform),
    })
    if (accounts.length >= limit) break
  }
  return accounts
}

function expandAccounts(pool: WsLoadAccount[], count: number, allowRepeat: boolean): WsLoadAccount[] {
  if (!pool.length) return []
  if (!allowRepeat && count > pool.length) {
    return pool.slice(0, pool.length)
  }
  return Array.from({ length: count }, (_, index) => pool[index % pool.length]!)
}

/** Mock uses synthetic IDs. Live FxSocket requires real linked terminal UUIDs. */
export async function resolveWsLoadAccounts(
  count: number,
  useMockServer: boolean,
): Promise<ResolvedWsLoadAccounts> {
  if (useMockServer) {
    return {
      source: 'mock',
      accounts: Array.from({ length: count }, (_, index) => ({
        accountId: `load-ws-acct-${index}`,
        platform: index % 2 === 0 ? 'MT5' : 'MT4',
      })),
    }
  }

  const fromEnv = parseEnvAccountIds()
  if (fromEnv.length) {
    const accounts = expandAccounts(fromEnv, count, false)
    if (accounts.length < count) {
      console.warn(
        `[ws-load] LOAD_WS_ACCOUNT_IDS has ${fromEnv.length} id(s);`
        + ` live WS load capped at ${accounts.length} (requested ${count})`,
      )
    }
    return {
      source: 'env',
      accounts,
    }
  }

  const fromDb = await fetchLinkedAccountsFromSupabase(count)
  if (fromDb.length) {
    const capped = Math.min(count, fromDb.length)
    if (capped < count) {
      console.warn(
        `[ws-load] only ${fromDb.length} linked FxSocket account(s) in Supabase;`
        + ` capping live WS load to ${capped} (requested ${count})`,
      )
    }
    return {
      source: 'supabase',
      accounts: fromDb.slice(0, capped),
    }
  }

  throw new Error(
    'Live FxSocket WS load requires real account IDs. Set LOAD_WS_ACCOUNT_IDS=uuid:MT5,uuid2:MT4'
    + ' or link broker_accounts with fxsocket_account_id in Supabase.',
  )
}

export function warnIfMockAccountCountHigh(count: number, useMockServer: boolean): void {
  if (!useMockServer || count <= MOCK_WS_SOFT_CAP) return
  console.warn(
    `[ws-load] mock mode: ${count.toLocaleString()} WebSocket clients exceeds recommended`
    + ` ${MOCK_WS_SOFT_CAP.toLocaleString()}. Expect ECONNREFUSED / low connect rate on one local`
    + ` mock server. Use LOAD_WS_MOCK_MAX_ACCOUNTS or lower LOAD_WS_ACCOUNTS, or LOAD_WS_LIVE=1`
    + ` with real FxSocket account IDs.`,
  )
}
