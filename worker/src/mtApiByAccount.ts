import type { SupabaseClient } from '@supabase/supabase-js'
import { getMetatraderApi, mtPlatformFrom, type MetatraderApiClient, type MtPlatform } from './metatraderapi'

export type PlatformByMetaapiId = Map<string, MtPlatform>

/** Resolve MT4/MT5 host per stored session id (metaapi_account_id). */
export async function loadPlatformByMetaapiId(
  supabase: SupabaseClient,
  metaapiIds: string[],
): Promise<PlatformByMetaapiId> {
  const out = new Map<string, MtPlatform>()
  const ids = [...new Set(metaapiIds.filter(id => id && !id.includes('|')))]
  if (!ids.length) return out
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('metaapi_account_id,platform')
    .in('metaapi_account_id', ids)
  if (error) {
    console.warn(`[mtApi] broker platform lookup failed: ${error.message}`)
    return out
  }
  for (const row of data ?? []) {
    const id = String((row as { metaapi_account_id?: string }).metaapi_account_id ?? '').trim()
    if (!id) continue
    out.set(id, mtPlatformFrom((row as { platform?: string }).platform))
  }
  return out
}

export function apiForMetaapiAccount(
  platformById: PlatformByMetaapiId,
  metaapiAccountId: string,
): MetatraderApiClient | null {
  return getMetatraderApi(platformById.get(metaapiAccountId) ?? 'MT5')
}
