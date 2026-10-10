import type { BrokerAccount } from '../types/database'
import type { DisplayableTradeActivity, TradeActivityLogRow } from './tradeActivities'
import { getBrokerDisplayLabel } from './brokerChannelLink'
import { normalizeSignalSourceKind, SIGNAL_SOURCE_MARKS, type SignalSourceKind } from './signalSourceMark'

/** Where a copier activity came from. New copy modes add a kind here. */
export type ActivitySourceKind = SignalSourceKind | 'broker'

export interface ActivityRouteMark {
  kind: string
  iconSrc: string
  label: string
}

export interface ActivityRoute {
  source: ActivityRouteMark | null
  destination: ActivityRouteMark | null
}

const SOURCE_KIND_MARKS = SIGNAL_SOURCE_MARKS

const PLATFORM_ICONS: Record<string, string> = {
  mt4: '/MT4.png',
  mt5: '/MT5.png',
  ctrader: '/cTrader.png',
  'match-trader': '/Match-Trader.png',
  matchtrader: '/Match-Trader.png',
  'trade-locker': '/Trade_locker.png',
  tradelocker: '/Trade_locker.png',
  tradovate: '/Tradovate.png',
  binance: '/Binance.png',
  'dx-trade': '/DX-trade.png',
  dxtrade: '/DX-trade.png',
}

type RouteBroker = Pick<BrokerAccount, 'id' | 'platform' | 'label' | 'broker_name' | 'account_login'>

function payloadString(row: TradeActivityLogRow, key: string): string | null {
  const value = row.request_payload?.[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function activityBrokerAccountId(row: TradeActivityLogRow): string | null {
  const direct = row.broker_account_id?.trim()
  if (direct) return direct
  return payloadString(row, 'broker_account_id') ?? payloadString(row, 'brokerAccountId')
}

export function platformIconSrc(platform: string): string | null {
  const raw = platform.trim()
  if (!raw) return null
  const key = raw.toLowerCase().replace(/[\s_]+/g, '-')
  return PLATFORM_ICONS[key] ?? `/${raw}.png`
}

export function resolveActivitySourceKind(
  row: TradeActivityLogRow,
  channelName: string | null,
  channelSourceKinds?: Record<string, SignalSourceKind>,
): ActivitySourceKind | null {
  const explicit = (payloadString(row, 'source_kind') ?? '').toLowerCase()
  if (explicit === 'broker') return 'broker'
  const channelId = row.signals?.channel_id ?? payloadString(row, 'channel_id')
  const fromChannel = channelId ? channelSourceKinds?.[channelId] : undefined
  if (fromChannel) return fromChannel
  const explicitSignal = normalizeSignalSourceKind(explicit)
  if (explicitSignal) return explicitSignal
  if (row.signals?.channel_id || channelName?.trim()) return 'telegram'
  return null
}

function brokerById(brokers: RouteBroker[], id: string | null): RouteBroker | undefined {
  if (!id) return undefined
  return brokers.find(broker => broker.id === id)
}

export function resolveActivityRoute(
  activity: Pick<DisplayableTradeActivity, 'row' | 'channelName' | 'sourceKind'>,
  brokers: RouteBroker[],
): ActivityRoute {
  const sourceKind = activity.sourceKind !== undefined
    ? activity.sourceKind
    : resolveActivitySourceKind(activity.row, activity.channelName)
  let source: ActivityRouteMark | null = null
  if (sourceKind === 'broker') {
    const sourceBroker = brokerById(brokers, payloadString(activity.row, 'source_broker_account_id'))
    const platform = sourceBroker?.platform ?? payloadString(activity.row, 'source_platform') ?? ''
    const iconSrc = platformIconSrc(platform)
    if (iconSrc) {
      source = {
        kind: 'broker',
        iconSrc,
        label: sourceBroker ? getBrokerDisplayLabel(sourceBroker as BrokerAccount) : platform,
      }
    }
  } else if (sourceKind) {
    const mark = SOURCE_KIND_MARKS[sourceKind]
    const name = activity.channelName?.trim()
    source = {
      kind: sourceKind,
      iconSrc: mark.iconSrc,
      label: name ? `${mark.label} · ${name}` : mark.label,
    }
  }

  const destinationBroker = brokerById(brokers, activityBrokerAccountId(activity.row))
  const platform = destinationBroker?.platform?.trim() ?? ''
  const destinationSrc = platformIconSrc(platform)
  const destination = destinationBroker && destinationSrc
    ? {
      kind: /^mt[45]$/i.test(platform) ? platform.toUpperCase() : platform,
      iconSrc: destinationSrc,
      label: getBrokerDisplayLabel(destinationBroker as BrokerAccount),
    }
    : null

  return { source, destination }
}
