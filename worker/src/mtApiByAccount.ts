import type { SupabaseClient } from '@supabase/supabase-js'
import { getFxsocketClient, type FxsocketBrokerClient, mtPlatformFrom, type MtPlatform } from './fxsocketClient'

export type PlatformByFxsocketId = Map<string, MtPlatform>

/** Resolve broker session id (FxSocket terminal UUID). */
export function brokerSessionId(row: {
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
}): string {
  const fx = String(row.fxsocket_account_id ?? '').trim()
  if (fx && !fx.includes('|')) return fx
  const legacy = String(row.metaapi_account_id ?? '').trim()
  if (legacy && !legacy.includes('|')) return legacy
  return ''
}

export async function loadPlatformByFxsocketId(
  supabase: SupabaseClient,
  sessionIds: string[],
): Promise<PlatformByFxsocketId> {
  const out = new Map<string, MtPlatform>()
  const ids = [...new Set(sessionIds.filter(id => id && !id.includes('|')))]
  if (!ids.length) return out
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('fxsocket_account_id,metaapi_account_id,platform')
    .or(`fxsocket_account_id.in.(${ids.join(',')}),metaapi_account_id.in.(${ids.join(',')})`)
  if (error) {
    console.warn(`[fxApi] broker platform lookup failed: ${error.message}`)
    return out
  }
  for (const row of data ?? []) {
    const id = brokerSessionId(row as { fxsocket_account_id?: string; metaapi_account_id?: string })
    if (!id) continue
    out.set(id, mtPlatformFrom((row as { platform?: string | null }).platform))
  }
  return out
}

/** @deprecated use loadPlatformByFxsocketId */
export const loadPlatformByMetaapiId = loadPlatformByFxsocketId
export type PlatformByMetaapiId = PlatformByFxsocketId

export function apiForFxsocketAccount(
  _platformById: PlatformByFxsocketId,
  sessionId: string,
): FxsocketBrokerClient | null {
  if (!sessionId || sessionId.includes('|')) return null
  return getFxsocketClient()
}

/** @deprecated use apiForFxsocketAccount */
export const apiForMetaapiAccount = apiForFxsocketAccount
