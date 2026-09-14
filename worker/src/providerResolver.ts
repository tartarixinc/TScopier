/**
 * Provider resolver — dispatches to the right BrokerProvider based on the
 * account's `provider` column. Phase 1: only FxsocketProvider is implemented.
 * MtapiProvider will be added in Phase 2.
 */
import type { BrokerProvider, BrokerProviderName } from './brokerProvider'
import { createFxsocketProvider } from './fxsocketProvider'

let fxsocketProvider: BrokerProvider | null = null

function getFxsocketProvider(): BrokerProvider {
  if (!fxsocketProvider) fxsocketProvider = createFxsocketProvider()
  return fxsocketProvider
}

/**
 * Resolve the BrokerProvider for a broker account row.
 *
 * @param provider - The `provider` column value from `broker_accounts`.
 * @param sessionId - The session ID (fxsocket_account_id or mtapi_session_id).
 * @returns The appropriate BrokerProvider, or null if the session ID is invalid
 *          or the provider is unknown.
 */
export function apiForBrokerAccount(
  provider: BrokerProviderName | string | null | undefined,
  sessionId: string,
): BrokerProvider | null {
  if (!sessionId || sessionId.includes('|')) return null

  switch (provider) {
    case 'fxsocket':
      return getFxsocketProvider()
    case 'mtapi':
      // Phase 2: return getMtapiProvider()
      console.warn('[providerResolver] mtapi provider not yet implemented; falling back to fxsocket')
      return getFxsocketProvider()
    default:
      // Unknown provider — fall back to fxsocket for forward compatibility.
      return getFxsocketProvider()
  }
}

/**
 * Infer provider from the broker_accounts row columns.
 * Falls back to 'fxsocket' when no provider column is present (pre-migration rows).
 */
export function inferProvider(row: {
  provider?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
}): BrokerProviderName {
  const explicit = String(row.provider ?? '').trim()
  if (explicit === 'mtapi') return 'mtapi'
  return 'fxsocket'
}
