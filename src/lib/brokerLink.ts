/** FxSocket-linked broker account (terminal UUID on broker_accounts). */
export function isFxsocketSessionUuid(fxsocketAccountId: string | null | undefined): boolean {
  const v = (fxsocketAccountId ?? '').trim()
  if (!v) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

/** Broker has a linked FxSocket terminal (connected slot), regardless of copy toggle. */
export function hasFxsocketBrokerSession(
  account: Pick<{ fxsocket_account_id?: string | null }, 'fxsocket_account_id'>,
): boolean {
  return isFxsocketSessionUuid(account.fxsocket_account_id)
}

/** Broker is eligible to copy new signals (Copy trades toggle on). */
export function isBrokerCopyEnabled(
  account: Pick<{ fxsocket_account_id?: string | null; is_active?: boolean }, 'fxsocket_account_id' | 'is_active'>,
): boolean {
  return account.is_active !== false && hasFxsocketBrokerSession(account)
}

/** Session-linked broker — use for metrics, streams, and connected counts. */
export function isFxsocketLinkedBroker(
  account: Pick<{ fxsocket_account_id?: string | null }, 'fxsocket_account_id'>,
): boolean {
  return hasFxsocketBrokerSession(account)
}

/** @deprecated Use isFxsocketSessionUuid */
export function isMtSessionUuid(metaapiAccountId: string | null | undefined): boolean {
  return isFxsocketSessionUuid(metaapiAccountId)
}

/** Pre–FxSocket rows stored `ServerName|Login` in metaapi_account_id. */
export function isLegacyBrokerLink(metaapiAccountId: string | null | undefined): boolean {
  const v = (metaapiAccountId ?? '').trim()
  return v.length > 0 && v.includes('|')
}

/** Count brokers using a plan slot (linked session, regardless of copy toggle). */
export function countLinkedBrokerSessions(brokers: readonly { fxsocket_account_id?: string | null }[]): number {
  return brokers.filter(hasFxsocketBrokerSession).length
}
