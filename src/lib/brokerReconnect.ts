import type { BrokerAccount } from '../types/database'
import { isMtSessionUuid } from './brokerLink'
import { brokerNeedsPasswordForReconnectMessage } from './brokerConnectError'

/** True only when the DB session flag is explicitly connected. */
export function isBrokerSessionConnected(
  account: Pick<BrokerAccount, 'connection_status'>,
): boolean {
  return account.connection_status === 'connected'
}

/** Broker has a MetatraderAPI session that can be restored via reconnect. */
export function brokerCanReconnect(
  account: Pick<BrokerAccount, 'metaapi_account_id' | 'connection_status'>,
): boolean {
  return isMtSessionUuid(account.metaapi_account_id) && !isBrokerSessionConnected(account)
}

export function brokerNeedsPasswordForReconnect(message: string | undefined): boolean {
  return brokerNeedsPasswordForReconnectMessage(message)
}

/** User-facing connection label for broker list rows (active accounts only). */
export function brokerConnectionStatusLabel(
  account: Pick<BrokerAccount, 'is_active' | 'connection_status'>,
  labels: { statusPaused: string; statusConnected: string; statusDisconnected: string },
): string {
  if (!account.is_active) return labels.statusPaused
  if (isBrokerSessionConnected(account)) return labels.statusConnected
  return labels.statusDisconnected
}

/** Badge variant for broker list connection state. */
export function brokerConnectionBadgeVariant(
  account: Pick<BrokerAccount, 'is_active' | 'connection_status'>,
): 'primary' | 'neutral' | 'error' {
  if (!account.is_active) return 'neutral'
  if (isBrokerSessionConnected(account)) return 'primary'
  return 'error'
}
