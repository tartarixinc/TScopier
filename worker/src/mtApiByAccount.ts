import type { SupabaseClient } from '@supabase/supabase-js'
import { type FxsocketBrokerClient, mtPlatformFrom, type MtPlatform } from './fxsocketClient'
import { apiForBrokerAccount } from './providerResolver'

export type BrokerApiMetadata = {
  platform: MtPlatform
  provider?: string | null
}

export type PlatformByFxsocketId = Map<string, BrokerApiMetadata>

/** Resolve the provider-specific broker session id. Unknown providers fail closed. */
export function brokerSessionId(row: {
  provider?: string | null
  mtapi_session_id?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
}): string {
  const provider = row.provider == null || row.provider === '' ? 'fxsocket' : row.provider
  if (provider === 'mtapi') {
    const mtapi = String(row.mtapi_session_id ?? '').trim()
    return mtapi && !mtapi.includes('|') ? mtapi : ''
  }
  if (provider !== 'fxsocket') return ''
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
  const out: PlatformByFxsocketId = new Map()
  const ids = [...new Set(sessionIds.filter(id => id && !id.includes('|')))]
  if (!ids.length) return out
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('mtapi_session_id,fxsocket_account_id,metaapi_account_id,platform,provider')
    .or(`mtapi_session_id.in.(${ids.join(',')}),fxsocket_account_id.in.(${ids.join(',')}),metaapi_account_id.in.(${ids.join(',')})`)
  if (error) {
    console.warn(`[fxApi] broker platform lookup failed: ${error.message}`)
    return out
  }
  for (const row of data ?? []) {
    const id = brokerSessionId(row as {
      provider?: string; mtapi_session_id?: string; fxsocket_account_id?: string; metaapi_account_id?: string
    })
    if (!id) continue
    out.set(id, {
      platform: mtPlatformFrom((row as { platform?: string | null }).platform),
      provider: (row as { provider?: string | null }).provider,
    })
  }
  return out
}

/** @deprecated use loadPlatformByFxsocketId */
export const loadPlatformByMetaapiId = loadPlatformByFxsocketId
export type PlatformByMetaapiId = PlatformByFxsocketId

export function apiForFxsocketAccount(
  platformById: PlatformByFxsocketId,
  sessionId: string,
): FxsocketBrokerClient | null {
  const metadata = platformById.get(sessionId)
  const api = apiForBrokerAccount(metadata?.provider, sessionId)
  if (api && metadata) api.seedPlatformCache(sessionId, metadata.platform)
  return api
}

/** @deprecated use apiForFxsocketAccount */
export const apiForMetaapiAccount = apiForFxsocketAccount
