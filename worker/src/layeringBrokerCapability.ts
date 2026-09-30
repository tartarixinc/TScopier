import type { FxsocketBrokerClient } from './fxsocketClient'

export type NativePendingCapabilityReason =
  | 'provider_unsupported'
  | 'platform_unsupported'
  | 'connection_not_ready'
  | 'native_methods_unavailable'
  | 'reconciliation_unavailable'
  | 'cancellation_unavailable'

export interface NativePendingCapability {
  supported: boolean
  provider: 'fxsocket' | 'mtapi' | 'unknown'
  platform: 'mt4' | 'mt5' | 'unknown'
  canPlace: boolean
  canReconcile: boolean
  canCancel: boolean
  reason: NativePendingCapabilityReason | 'supported'
}

export interface NativePendingCapabilityInput {
  readonly broker?: {
    readonly platform?: string | null
    readonly provider?: string | null
    readonly fxsocket_account_id?: string | null
    readonly metaapi_account_id?: string | null
    readonly connection_status?: string | null
    readonly terminal_connected?: boolean | null
    readonly trade_allowed?: boolean | null
  } | null
  readonly api?: Partial<FxsocketBrokerClient> | null
}

function hasMethod(api: Partial<FxsocketBrokerClient> | null | undefined, name: keyof FxsocketBrokerClient): boolean {
  return typeof api?.[name] === 'function'
}

export function resolveNativePendingCapability(input: NativePendingCapabilityInput): NativePendingCapability {
  const broker = input.broker
  const platformRaw = String(broker?.platform ?? '').trim().toUpperCase()
  const platform = platformRaw === 'MT4' ? 'mt4' : platformRaw === 'MT5' ? 'mt5' : 'unknown'
  const linked = Boolean(String(broker?.fxsocket_account_id ?? broker?.metaapi_account_id ?? '').trim())
  const connected = broker?.connection_status === 'connected' || broker?.terminal_connected === true
  const tradeAllowed = broker?.trade_allowed !== false
  const explicitProvider = String(broker?.provider ?? '').trim()
  const provider: NativePendingCapability['provider'] =
    explicitProvider === 'fxsocket' ? 'fxsocket'
    : explicitProvider === 'mtapi' ? 'mtapi'
    : explicitProvider ? 'unknown'
    : linked ? 'fxsocket'
    : 'unknown'
  const api = input.api
  const canPlace = hasMethod(api, 'orderSend') && hasMethod(api, 'quote')
  const canReconcile = hasMethod(api, 'openedOrders')
  const canCancel = hasMethod(api, 'orderClose')

  // Phase 1 has no MTAPI provider implementation. Native layering must remain
  // unavailable instead of implying that MTAPI order methods are supported.
  if (provider !== 'fxsocket') {
    return { supported: false, provider, platform, canPlace, canReconcile, canCancel, reason: 'provider_unsupported' }
  }
  if (platform !== 'mt4' && platform !== 'mt5') {
    return { supported: false, provider, platform, canPlace, canReconcile, canCancel, reason: 'platform_unsupported' }
  }
  if (!connected || !tradeAllowed) {
    return { supported: false, provider, platform, canPlace, canReconcile, canCancel, reason: 'connection_not_ready' }
  }
  if (!canPlace) {
    return { supported: false, provider, platform, canPlace, canReconcile, canCancel, reason: 'native_methods_unavailable' }
  }
  if (!canReconcile) {
    return { supported: false, provider, platform, canPlace, canReconcile, canCancel, reason: 'reconciliation_unavailable' }
  }
  if (!canCancel) {
    return { supported: false, provider, platform, canPlace, canReconcile, canCancel, reason: 'cancellation_unavailable' }
  }
  return { supported: true, provider, platform, canPlace, canReconcile, canCancel, reason: 'supported' }
}
