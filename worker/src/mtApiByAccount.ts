import type { SupabaseClient } from '@supabase/supabase-js'
import { type FxsocketBrokerClient, mtPlatformFrom, type MtPlatform } from './fxsocketClient'
import { apiForBrokerAccount } from './providerResolver'
import { authorityFromBrokerRow, type BrokerWriteAuthority } from './brokerWriteAuthority'

export type BrokerApiMetadata = {
  brokerAccountId: string
  sessionId: string
  platform: MtPlatform
  provider?: string | null
  /** Broker account login (number), used to corroborate that a snapshot belongs to this account. */
  accountLogin?: string | null
  manualSettings?: Record<string, unknown> | null
  authority?: BrokerWriteAuthority | null
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
    .select('id,mtapi_session_id,fxsocket_account_id,metaapi_account_id,platform,provider,writer_epoch,provider_transition_state')
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
      brokerAccountId: String((row as { id?: unknown }).id ?? ''),
      sessionId: id,
      platform: mtPlatformFrom((row as { platform?: string | null }).platform),
      provider: (row as { provider?: string | null }).provider,
      authority: authorityFromBrokerRow(row),
    })
  }
  return out
}

export type BrokerApiByAccountId = Map<string, BrokerApiMetadata>

/**
 * Resolve durable work by broker row identity, never by a session captured in
 * the work item. The returned session/provider/epoch are the current values
 * from broker_accounts at execution time.
 */
export async function loadBrokerApiByAccountId(
  supabase: SupabaseClient,
  brokerAccountIds: string[],
): Promise<BrokerApiByAccountId> {
  const out: BrokerApiByAccountId = new Map()
  const ids = [...new Set(brokerAccountIds.map(id => String(id ?? '').trim()).filter(Boolean))]
  if (!ids.length) return out
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('id,mtapi_session_id,fxsocket_account_id,metaapi_account_id,platform,provider,writer_epoch,provider_transition_state,manual_settings,account_login')
    .in('id', ids)
  if (error) {
    console.warn('[brokerApi] broker authority lookup failed: ' + error.message)
    return out
  }
  for (const row of data ?? []) {
    const brokerAccountId = String((row as { id?: unknown }).id ?? '').trim()
    const sessionId = brokerSessionId(row)
    if (!brokerAccountId || !sessionId) continue
    const accountLogin = String((row as { account_login?: unknown }).account_login ?? '').trim()
    out.set(brokerAccountId, {
      brokerAccountId,
      sessionId,
      platform: mtPlatformFrom((row as { platform?: string | null }).platform),
      provider: (row as { provider?: string | null }).provider,
      accountLogin: accountLogin || null,
      authority: authorityFromBrokerRow(row),
      manualSettings: (row as { manual_settings?: Record<string, unknown> | null }).manual_settings ?? null,
    })
  }
  return out
}

export function brokerRuntimeForAccount(
  byAccountId: BrokerApiByAccountId,
  brokerAccountId: string | null | undefined,
): (BrokerApiMetadata & { api: FxsocketBrokerClient }) | null {
  const metadata = byAccountId.get(String(brokerAccountId ?? '').trim())
  if (!metadata?.authority || metadata.authority.transitionState !== 'stable') return null
  const api = apiForBrokerAccount(metadata.provider, metadata.sessionId, metadata.authority)
  if (!api) return null
  api.seedPlatformCache(metadata.sessionId, metadata.platform)
  return { ...metadata, api }
}

export async function resolveDurableBrokerArtifacts<
  T extends { broker_account_id: string; metaapi_account_id: string },
>(
  supabase: SupabaseClient,
  artifacts: T[],
): Promise<{ rows: T[]; platformBySession: PlatformByFxsocketId }> {
  const byBroker = await loadBrokerApiByAccountId(
    supabase,
    [...new Set(artifacts.map(row => row.broker_account_id).filter(Boolean))],
  )
  const rows: T[] = []
  const platformBySession: PlatformByFxsocketId = new Map()
  for (const row of artifacts) {
    const metadata = byBroker.get(String(row.broker_account_id ?? '').trim())
    if (!metadata?.authority || metadata.authority.transitionState !== 'stable') continue
    platformBySession.set(metadata.sessionId, metadata)
    rows.push({ ...row, metaapi_account_id: metadata.sessionId })
  }
  return { rows, platformBySession }
}

/** @deprecated use loadPlatformByFxsocketId */
export const loadPlatformByMetaapiId = loadPlatformByFxsocketId
export type PlatformByMetaapiId = PlatformByFxsocketId

export function apiForFxsocketAccount(
  platformById: PlatformByFxsocketId,
  sessionId: string,
): FxsocketBrokerClient | null {
  const metadata = platformById.get(sessionId)
  const api = apiForBrokerAccount(metadata?.provider, sessionId, metadata?.authority)
  if (api && metadata) api.seedPlatformCache(sessionId, metadata.platform)
  return api
}

/** @deprecated use apiForFxsocketAccount */
export const apiForMetaapiAccount = apiForFxsocketAccount
