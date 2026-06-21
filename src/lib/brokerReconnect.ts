import type { BrokerAccount } from '../types/database'
import { hasFxsocketBrokerSession } from './brokerLink'

export function isBrokerSessionHealthy(
  account: Pick<BrokerAccount, 'fxsocket_status' | 'connection_status'>,
): boolean {
  const status = account.fxsocket_status ?? account.connection_status
  return status === 'connected' || status === 'connecting' || status === 'recovering'
}

export function isBrokerSessionConnected(
  account: Pick<BrokerAccount, 'fxsocket_status' | 'connection_status'>,
): boolean {
  const status = account.fxsocket_status ?? account.connection_status
  return status === 'connected'
}

export function brokerCanReconnect(
  account: Pick<BrokerAccount, 'fxsocket_account_id' | 'fxsocket_status' | 'connection_status'>,
): boolean {
  const status = account.fxsocket_status ?? account.connection_status
  return hasFxsocketBrokerSession(account) && status === 'error'
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
  account: Pick<BrokerAccount, 'fxsocket_status' | 'connection_status'>,
): 'connected' | 'connecting' | 'recovering' | 'disconnected' {
  if (account.connection_status === 'pending') return 'connecting'
  if (account.connection_status === 'recovering') return 'recovering'

  const status = account.fxsocket_status ?? account.connection_status
  if (status === 'connected') return 'connected'
  if (status === 'connecting') return 'recovering'
  return 'disconnected'
}

export function brokerConnectionStatusLabel(
  account: Pick<BrokerAccount, 'is_active' | 'fxsocket_status' | 'connection_status'>,
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
  account: Pick<BrokerAccount, 'is_active' | 'fxsocket_status' | 'connection_status'>,
): 'primary' | 'neutral' | 'error' {
  if (!account.is_active) return 'neutral'
  const status = account.fxsocket_status ?? account.connection_status
  if (status === 'connected' || status === 'connecting' || status === 'recovering') return 'primary'
  return 'error'
}
