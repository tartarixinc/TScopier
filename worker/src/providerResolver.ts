/** Provider resolution. Null remains the legacy FXSocket default; unknown values fail closed. */
import type { FxsocketBrokerClient } from './fxsocketClient'
import type { BrokerProvider, BrokerProviderName } from './brokerProvider'
import { createFxsocketProvider, type FxsocketProvider } from './fxsocketProvider'
import { getMtapiProvider, type MtapiProvider } from './mtapiProvider'

export type ResolvedBrokerProvider = BrokerProvider & FxsocketBrokerClient

let fxsocketProvider: FxsocketProvider | null | undefined
let mtapiProvider: MtapiProvider | null | undefined

function getFxsocketProvider(): FxsocketProvider | null {
  if (fxsocketProvider === undefined) fxsocketProvider = createFxsocketProvider()
  return fxsocketProvider
}

function resolveMtapiProvider(): MtapiProvider | null {
  if (mtapiProvider === undefined) mtapiProvider = getMtapiProvider()
  return mtapiProvider
}

export function apiForBrokerAccount(
  provider: BrokerProviderName | string | null | undefined,
  sessionId: string | null | undefined,
): ResolvedBrokerProvider | null {
  const id = String(sessionId ?? '').trim()
  if (!id || id.includes('|')) return null

  const value = provider == null || provider === '' ? 'fxsocket' : provider
  if (value === 'fxsocket') return getFxsocketProvider() as ResolvedBrokerProvider | null
  if (value === 'mtapi') {
    return resolveMtapiProvider() as unknown as ResolvedBrokerProvider | null
  }
  return null
}

/** Null/absent is the legacy FXSocket default; every other invalid value closes. */
export function inferProvider(row: { provider?: string | null }): BrokerProviderName | null {
  if (row.provider == null || row.provider === '') return 'fxsocket'
  const explicit = String(row.provider).trim()
  if (explicit === 'fxsocket' || explicit === 'mtapi') return explicit
  return null
}

export function resetProviderResolverForTests(): void {
  fxsocketProvider = undefined
  mtapiProvider = undefined
}

export function setFxsocketProviderForTests(provider: FxsocketProvider | null): void {
  fxsocketProvider = provider
}

export function setMtapiProviderForResolverTests(provider: MtapiProvider | null): void {
  mtapiProvider = provider
}
