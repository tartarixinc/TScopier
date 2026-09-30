import type { BrokerAccount } from '../types/database'
import { hasFxsocketBrokerSession, hasMtapiBrokerSession, resolveProvider } from './brokerLink'

type BrokerAccountLike = Pick<BrokerAccount, 'fxsocket_status' | 'connection_status'> & {
  provider?: string | null
  mtapi_status?: string | null
}

/** Prefer worker-marked connection_status=error over a stale provider status=connected. */
export function brokerEffectiveConnectionStatus(
  account: BrokerAccountLike,
): string | null {
  if (account.connection_status === 'error') {
    return 'error'
  }
  if (account.connection_status === 'pending' || account.connection_status === 'recovering') {
    return account.connection_status
  }

  const provider = resolveProvider(account)
  if (provider === 'mtapi') {
    return account.mtapi_status ?? account.connection_status ?? null
  }
  return account.fxsocket_status ?? account.connection_status ?? null
}

export function isBrokerSessionHealthy(
  account: BrokerAccountLike,
): boolean {
  const status = brokerEffectiveConnectionStatus(account)
  return status === 'connected' || status === 'connecting' || status === 'recovering'
}

export function isBrokerSessionConnected(
  account: BrokerAccountLike,
): boolean {
  return brokerEffectiveConnectionStatus(account) === 'connected'
}

type BrokerAccountLikeReconnect = BrokerAccountLike & {
  fxsocket_account_id?: string | null
  mtapi_session_id?: string | null
}

export function brokerCanReconnect(
  account: BrokerAccountLikeReconnect,
): boolean {
  const provider = resolveProvider(account)
  if (provider === 'mtapi') {
    if (!hasMtapiBrokerSession(account)) return false
  } else {
    if (!hasFxsocketBrokerSession(account)) return false
  }
  const status = brokerEffectiveConnectionStatus(account)
  return status === 'error' || status === 'disconnected'
}

type BrokerConnectionStatusLabels = {
  statusPaused: string
  statusConnected: string
  statusConnecting: string
  statusRecovering: string
  statusDisconnected: string
}

/** User-facing link state — pending first-time connect vs session recovery. */
function brokerConnectionDisplayPhase(
  account: BrokerAccountLike,
): 'connected' | 'connecting' | 'recovering' | 'disconnected' {
  if (account.connection_status === 'pending') return 'connecting'
  if (account.connection_status === 'recovering') return 'recovering'

  const status = brokerEffectiveConnectionStatus(account)
  if (status === 'connected') return 'connected'
  if (status === 'connecting') return 'recovering'
  return 'disconnected'
}

export function brokerConnectionStatusLabel(
  account: BrokerAccountLike & { is_active?: boolean },
  labels: BrokerConnectionStatusLabels,
): string {
  if (!account.is_active) return labels.statusPaused

  const phase = brokerConnectionDisplayPhase(account)
  if (phase === 'connected') return labels.statusConnected
  if (phase === 'connecting') return labels.statusConnecting
  if (phase === 'recovering') return labels.statusRecovering
  return labels.statusDisconnected
}

export function brokerConnectionBadgeVariant(
  account: BrokerAccountLike & { is_active?: boolean },
): 'primary' | 'neutral' | 'error' {
  if (!account.is_active) return 'neutral'
  const status = brokerEffectiveConnectionStatus(account)
  if (status === 'connected' || status === 'connecting' || status === 'recovering' || status === 'pending') {
    return 'primary'
  }
  return 'error'
}
