import type { BrokerAccount } from '../types/database'

export type SocialAccountMode = 'demo' | 'live' | 'unknown'

export function socialBrokerDisplayLabel(account: Pick<BrokerAccount, 'label' | 'broker_name' | 'platform'>): string {
  return account.label?.trim() || account.broker_name?.trim() || account.platform?.toUpperCase() || 'Broker account'
}
export function resolveSocialAccountMode(account: Pick<BrokerAccount,
  | 'provider'
  | 'linked_account_type'
  | 'ctrader_environment'
  | 'binance_environment'
  | 'bybit_environment'
  | 'tradelocker_environment'
>): SocialAccountMode {
  const linked = String(account.linked_account_type ?? '').trim().toLowerCase()
  const provider = String(account.provider ?? '').trim().toLowerCase()
  const providerEnvironment = String(
    provider === 'ctrader'
      ? account.ctrader_environment
      : provider === 'binance'
        ? account.binance_environment
        : provider === 'bybit'
          ? account.bybit_environment
          : provider === 'tradelocker'
            ? account.tradelocker_environment
            : '',
  ).trim().toLowerCase()

  const linkedMode: SocialAccountMode = linked === 'demo' || linked === 'practice'
    ? 'demo'
    : linked === 'live' ? 'live' : 'unknown'
  const environmentMode: SocialAccountMode = providerEnvironment === 'demo' || providerEnvironment === 'live'
    ? providerEnvironment
    : 'unknown'

  if (linkedMode !== 'unknown' && environmentMode !== 'unknown' && linkedMode !== environmentMode) return 'unknown'
  return linkedMode !== 'unknown' ? linkedMode : environmentMode
}

export function maskBrokerAccountIdentifier(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim()
  if (!normalized) return 'Identifier unavailable'
  const visible = normalized.slice(-4)
  return `${'\u2022'.repeat(Math.max(4, Math.min(8, normalized.length - visible.length)))}${visible}`
}

export function brokerConnectionLabel(account: Pick<BrokerAccount,
  | 'provider'
  | 'connection_status'
  | 'fxsocket_status'
  | 'mtapi_status'
  | 'ctrader_status'
  | 'binance_status'
  | 'bybit_status'
  | 'kucoin_status'
  | 'dxtrade_status'
  | 'tradelocker_status'
  | 'matchtrader_status'
>): string {
  const providerStatus = account.provider === 'mtapi' ? account.mtapi_status
    : account.provider === 'ctrader' ? account.ctrader_status
      : account.provider === 'binance' ? account.binance_status
        : account.provider === 'bybit' ? account.bybit_status
          : account.provider === 'kucoin' ? account.kucoin_status
            : account.provider === 'dxtrade' ? account.dxtrade_status
              : account.provider === 'tradelocker' ? account.tradelocker_status
                : account.provider === 'matchtrader' ? account.matchtrader_status
                  : account.fxsocket_status
  const status = String(providerStatus ?? account.connection_status ?? '').toLowerCase()
  if (status === 'connected' || status === 'healthy') return 'Connected'
  if (status === 'connecting' || status === 'pending' || status === 'recovering') return 'Connecting'
  if (status === 'error') return 'Connection error'
  if (status === 'disconnected') return 'Disconnected'
  return 'Status unavailable'
}

export function isSocialCopyProviderSupported(account: Pick<BrokerAccount, 'provider' | 'platform'>): boolean {
  const provider = String(account.provider ?? 'fxsocket').trim().toLowerCase()
  const platform = String(account.platform ?? '').trim().toUpperCase()
  return (provider === 'fxsocket' || provider === 'mtapi')
    && (platform === 'MT4' || platform === 'MT5')
}

/** Canonical provider-aware trade identity. Numeric MetaTrader providers use a
 * positive JavaScript-safe integer string; opaque-capable providers preserve
 * their non-empty trimmed string without numeric coercion. */
const SOCIAL_OPAQUE_TICKET_PROVIDERS = new Set(['ctrader', 'binance', 'bybit', 'kucoin', 'dxtrade', 'tradelocker', 'matchtrader'])

export function normalizeSocialBrokerTicket(provider: string | null | undefined, ticket: string | null | undefined): string | null {
  const normalizedProvider = provider?.trim().toLowerCase() || 'fxsocket'
  if (typeof ticket !== 'string') return null
  if (normalizedProvider === 'fxsocket' || normalizedProvider === 'mtapi') {
    if (!/^[0-9]+$/.test(ticket)) return null
    try {
      const numeric = BigInt(ticket)
      return numeric > 0n && numeric <= BigInt(Number.MAX_SAFE_INTEGER) ? numeric.toString() : null
    } catch { return null }
  }
  if (!SOCIAL_OPAQUE_TICKET_PROVIDERS.has(normalizedProvider)) return null
  const opaque = ticket.trim()
  return opaque.length > 0 && opaque.length <= 255 && !/[\u0000-\u001f\u007f]/.test(opaque) ? opaque : null
}

export function isVerifiedSocialBrokerTicket(provider: string | null | undefined, ticket: string | null | undefined): boolean {
  return normalizeSocialBrokerTicket(provider, ticket) != null
}

export function isSocialDestinationEligible(account: BrokerAccount): boolean {
  const mode = resolveSocialAccountMode(account)
  return account.is_active === true
    && isSocialCopyProviderSupported(account)
    && brokerConnectionLabel(account) === 'Connected'
    && (mode === 'demo' || mode === 'live')
}
