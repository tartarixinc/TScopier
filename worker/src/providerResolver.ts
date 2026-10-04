/** Provider resolution. Null remains the legacy FXSocket default; unknown values fail closed. */
import type { FxsocketBrokerClient } from './fxsocketClient'
import type { BrokerProvider, BrokerProviderName } from './brokerProvider'
import { createFxsocketProvider, type FxsocketProvider } from './fxsocketProvider'
import { getMtapiProvider, type MtapiProvider } from './mtapiProvider'
import {
  type BrokerWriteAuthority,
  brokerWriteAuthorityStoreRegistered,
  withBrokerWriteAuthority,
} from './brokerWriteAuthority'

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
  authority?: BrokerWriteAuthority | null,
): ResolvedBrokerProvider | null {
  const id = String(sessionId ?? '').trim()
  if (!id || id.includes('|')) return null

  const value = provider == null || provider === '' ? 'fxsocket' : provider
  let resolved: ResolvedBrokerProvider | null = null
  if (value === 'fxsocket') resolved = getFxsocketProvider() as ResolvedBrokerProvider | null
  if (value === 'mtapi') {
    resolved = resolveMtapiProvider() as unknown as ResolvedBrokerProvider | null
  }
  if (!resolved) return null
  if (!brokerWriteAuthorityStoreRegistered()) return resolved

  const guardedMethods = new Set(['orderSend', 'orderModify', 'orderClose'])
  return new Proxy(resolved, {
    get(target, prop, receiver) {
      const member = Reflect.get(target, prop, receiver)
      if (typeof member !== 'function') return member
      if (!guardedMethods.has(String(prop))) return member.bind(target)
      return (callSessionId: string, ...args: unknown[]) => {
        if (authority && callSessionId !== authority.sessionId) {
          throw new Error('BROKER_WRITE_FENCE_REJECTED')
        }
        return withBrokerWriteAuthority(
          authority,
          String(prop),
          () => member.call(target, callSessionId, ...args),
        )
      }
    },
  })
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
