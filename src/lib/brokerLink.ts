export type BrokerProvider = 'fxsocket' | 'mtapi'

type ProviderAwareAccount = {
  fxsocket_account_id?: string | null
  provider?: string | null
  mtapi_session_id?: string | null
}

/** Resolve the effective provider for an account (defaults to 'fxsocket'). */
export function resolveProvider(account: ProviderAwareAccount): BrokerProvider {
  return account.provider === 'mtapi' ? 'mtapi' : 'fxsocket'
}

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

/** Broker has a linked MTAPI session. */
export function hasMtapiBrokerSession(
  account: Pick<{ mtapi_session_id?: string | null }, 'mtapi_session_id'>,
): boolean {
  return (account.mtapi_session_id ?? '').trim().length > 0
}

/** Broker has a linked session of any provider (FxSocket or MTAPI). */
export function hasAnyBrokerSession(account: ProviderAwareAccount): boolean {
  if (resolveProvider(account) === 'mtapi') return hasMtapiBrokerSession(account)
  return hasFxsocketBrokerSession(account)
}

/**
 * Client-safe “is this account linked?” gate for UI that loads
 * `BROKER_ACCOUNT_CLIENT_SELECT` (no `mtapi_session_id` — stripped/not selected).
 * MTAPI: any row with provider=mtapi counts (session presence is server-only).
 * FxSocket: still requires a terminal UUID.
 */
export function hasLinkedBrokerForUi(
  account: ProviderAwareAccount & { mtapi_status?: string | null },
): boolean {
  if (resolveProvider(account) === 'mtapi') return true
  return hasFxsocketBrokerSession(account)
}

/** Broker is eligible to copy new signals (Copy trades toggle on). */
export function isBrokerCopyEnabled(
  account: ProviderAwareAccount & { is_active?: boolean },
): boolean {
  return account.is_active !== false && hasAnyBrokerSession(account)
}

/**
 * Client-safe copy-toggle check for `BROKER_ACCOUNT_CLIENT_SELECT` rows
 * (no `mtapi_session_id`). Same product rule as `isBrokerCopyEnabled`.
 */
export function isBrokerCopyEnabledForUi(
  account: ProviderAwareAccount & { is_active?: boolean; mtapi_status?: string | null },
): boolean {
  return account.is_active !== false && hasLinkedBrokerForUi(account)
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

/** Count brokers using a plan slot (linked session of any provider, regardless of copy toggle). */
export function countLinkedBrokerSessions(brokers: readonly ProviderAwareAccount[]): number {
  return brokers.filter(hasAnyBrokerSession).length
}

/** Client-safe plan-slot count for rows without `mtapi_session_id`. */
export function countLinkedBrokerSessionsForUi(
  brokers: readonly (ProviderAwareAccount & { mtapi_status?: string | null })[],
): number {
  return brokers.filter(hasLinkedBrokerForUi).length
}
