/** Provider resolution. Null remains the legacy FXSocket default; unknown values fail closed. */
import type { FxsocketBrokerClient } from './fxsocketClient'
import type { BrokerProvider, BrokerProviderName } from './brokerProvider'
import { createFxsocketProvider, type FxsocketProvider } from './fxsocketProvider'
import { getMtapiProvider, type MtapiProvider } from './mtapiProvider'
import { getCtraderProvider, type CtraderProvider } from './ctraderProvider'
import { getBinanceProvider, type BinanceProvider } from './binanceProvider'
import { getBybitProvider, type BybitProvider } from './bybitProvider'
import { getKucoinProvider, type KucoinProvider } from './kucoinProvider'
import { getDxtradeProvider, type DxtradeProvider } from './dxtradeProvider'
import { getTradelockerProvider, type TradelockerProvider } from './tradelockerProvider'
import { getMatchtraderProvider, type MatchtraderProvider } from './matchtraderProvider'
import {
  type BrokerWriteAuthority,
  brokerWriteAuthorityStoreRegistered,
  withBrokerWriteAuthority,
} from './brokerWriteAuthority'

export type ResolvedBrokerProvider = BrokerProvider & FxsocketBrokerClient

let fxsocketProvider: FxsocketProvider | null | undefined
let mtapiProvider: MtapiProvider | null | undefined
let ctraderProvider: CtraderProvider | null | undefined
let binanceProvider: BinanceProvider | null | undefined
let bybitProvider: BybitProvider | null | undefined
let kucoinProvider: KucoinProvider | null | undefined
let dxtradeProvider: DxtradeProvider | null | undefined
let tradelockerProvider: TradelockerProvider | null | undefined
let matchtraderProvider: MatchtraderProvider | null | undefined

function getFxsocketProvider(): FxsocketProvider | null {
  if (fxsocketProvider === undefined) fxsocketProvider = createFxsocketProvider()
  return fxsocketProvider
}

function resolveMtapiProvider(): MtapiProvider | null {
  if (mtapiProvider === undefined) mtapiProvider = getMtapiProvider()
  return mtapiProvider
}

function resolveCtraderProvider(): CtraderProvider | null {
  if (ctraderProvider === undefined) ctraderProvider = getCtraderProvider()
  return ctraderProvider
}

function resolveBinanceProvider(): BinanceProvider | null {
  if (binanceProvider === undefined) binanceProvider = getBinanceProvider()
  return binanceProvider
}

function resolveKucoinProvider(): KucoinProvider | null {
  if (kucoinProvider === undefined) kucoinProvider = getKucoinProvider()
  return kucoinProvider
}

function resolveDxtradeProvider(): DxtradeProvider | null {
  if (dxtradeProvider === undefined) dxtradeProvider = getDxtradeProvider()
  return dxtradeProvider
}

function resolveTradelockerProvider(): TradelockerProvider | null {
  if (tradelockerProvider === undefined) tradelockerProvider = getTradelockerProvider()
  return tradelockerProvider
}

function resolveMatchtraderProvider(): MatchtraderProvider | null {
  if (matchtraderProvider === undefined) matchtraderProvider = getMatchtraderProvider()
  return matchtraderProvider
}

function resolveBybitProvider(): BybitProvider | null {
  if (bybitProvider === undefined) bybitProvider = getBybitProvider()
  return bybitProvider
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
  if (value === 'ctrader') {
    resolved = resolveCtraderProvider() as unknown as ResolvedBrokerProvider | null
  }
  if (value === 'binance') {
    resolved = resolveBinanceProvider() as unknown as ResolvedBrokerProvider | null
  }
  if (value === 'bybit') {
    resolved = resolveBybitProvider() as unknown as ResolvedBrokerProvider | null
  }
  if (value === 'kucoin') {
    resolved = resolveKucoinProvider() as unknown as ResolvedBrokerProvider | null
  }
  if (value === 'dxtrade') {
    resolved = resolveDxtradeProvider() as unknown as ResolvedBrokerProvider | null
  }
  if (value === 'tradelocker') {
    resolved = resolveTradelockerProvider() as unknown as ResolvedBrokerProvider | null
  }
  if (value === 'matchtrader') {
    resolved = resolveMatchtraderProvider() as unknown as ResolvedBrokerProvider | null
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
  if (explicit === 'fxsocket' || explicit === 'mtapi' || explicit === 'ctrader' || explicit === 'binance' || explicit === 'bybit' || explicit === 'kucoin' || explicit === 'dxtrade' || explicit === 'tradelocker' || explicit === 'matchtrader') return explicit
  return null
}

export function resetProviderResolverForTests(): void {
  fxsocketProvider = undefined
  mtapiProvider = undefined
  ctraderProvider = undefined
  binanceProvider = undefined
  bybitProvider = undefined
  kucoinProvider = undefined
  dxtradeProvider = undefined
  tradelockerProvider = undefined
  matchtraderProvider = undefined
}

export function setFxsocketProviderForTests(provider: FxsocketProvider | null): void {
  fxsocketProvider = provider
}

export function setMtapiProviderForResolverTests(provider: MtapiProvider | null): void {
  mtapiProvider = provider
}

export function setCtraderProviderForResolverTests(provider: CtraderProvider | null): void {
  ctraderProvider = provider
}

export function setBinanceProviderForResolverTests(provider: BinanceProvider | null): void {
  binanceProvider = provider
}

export function setBybitProviderForResolverTests(provider: BybitProvider | null): void {
  bybitProvider = provider
}

export function setKucoinProviderForResolverTests(provider: KucoinProvider | null): void {
  kucoinProvider = provider
}

export function setDxtradeProviderForResolverTests(provider: DxtradeProvider | null): void {
  dxtradeProvider = provider
}

export function setTradelockerProviderForResolverTests(provider: TradelockerProvider | null): void {
  tradelockerProvider = provider
}

export function setMatchtraderProviderForResolverTests(provider: MatchtraderProvider | null): void {
  matchtraderProvider = provider
}
