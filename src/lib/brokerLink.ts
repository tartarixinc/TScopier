export type BrokerProvider = 'fxsocket' | 'mtapi' | 'ctrader' | 'binance' | 'bybit' | 'kucoin' | 'dxtrade'

type ProviderAwareAccount = {
  fxsocket_account_id?: string | null
  provider?: string | null
  mtapi_session_id?: string | null
  ctrader_account_id?: string | null
  binance_account_id?: string | null
  bybit_account_id?: string | null
  kucoin_account_id?: string | null
  dxtrade_account_id?: string | null
}

/** Resolve the effective provider for an account (defaults to 'fxsocket'). */
export function resolveProvider(account: ProviderAwareAccount): BrokerProvider {
  if (account.provider === 'mtapi') return 'mtapi'
  if (account.provider === 'ctrader') return 'ctrader'
  if (account.provider === 'binance') return 'binance'
  if (account.provider === 'bybit') return 'bybit'
  if (account.provider === 'kucoin') return 'kucoin'
  if (account.provider === 'dxtrade') return 'dxtrade'
  return 'fxsocket'
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

/** Broker has a linked cTrader trading account. */
export function hasCtraderBroker(
  account: Pick<ProviderAwareAccount, 'provider' | 'ctrader_account_id'>,
): boolean {
  if (account.provider === 'ctrader') return true
  return (account.ctrader_account_id ?? '').trim().length > 0
}

/** Broker has a linked Binance futures API key. */
export function hasBinanceBroker(
  account: Pick<ProviderAwareAccount, 'provider' | 'binance_account_id'>,
): boolean {
  if (account.provider === 'binance') return true
  return (account.binance_account_id ?? '').trim().length > 0
}

/** Broker has a linked Bybit linear futures API key. */
export function hasBybitBroker(
  account: Pick<ProviderAwareAccount, 'provider' | 'bybit_account_id'>,
): boolean {
  if (account.provider === 'bybit') return true
  return (account.bybit_account_id ?? '').trim().length > 0
}

/** Broker has a linked KuCoin futures API key. */
export function hasKucoinBroker(
  account: Pick<ProviderAwareAccount, 'provider' | 'kucoin_account_id'>,
): boolean {
  if (account.provider === 'kucoin') return true
  return (account.kucoin_account_id ?? '').trim().length > 0
}

/** Broker has a linked DXtrade trading account. */
export function hasDxtradeBroker(
  account: Pick<ProviderAwareAccount, 'provider' | 'dxtrade_account_id'>,
): boolean {
  if (account.provider === 'dxtrade') return true
  return (account.dxtrade_account_id ?? '').trim().length > 0
}

/** Broker has a linked session of any provider (FxSocket, MTAPI, cTrader, Binance, Bybit, KuCoin, or DXtrade). */
export function hasAnyBrokerSession(account: ProviderAwareAccount): boolean {
  const provider = resolveProvider(account)
  if (provider === 'mtapi') return hasMtapiBrokerSession(account)
  if (provider === 'ctrader') return hasCtraderBroker(account)
  if (provider === 'binance') return hasBinanceBroker(account)
  if (provider === 'bybit') return hasBybitBroker(account)
  if (provider === 'kucoin') return hasKucoinBroker(account)
  if (provider === 'dxtrade') return hasDxtradeBroker(account)
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
  const provider = resolveProvider(account)
  if (provider === 'mtapi' || provider === 'ctrader' || provider === 'binance' || provider === 'bybit' || provider === 'kucoin' || provider === 'dxtrade') return true
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
  account: Pick<ProviderAwareAccount, 'provider' | 'fxsocket_account_id'>,
): boolean {
  return resolveProvider(account) === 'fxsocket' && hasFxsocketBrokerSession(account)
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
