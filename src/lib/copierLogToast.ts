import type { CopierLogsTranslations, SignalHistoryPageTranslations } from '../i18n/locales/types'
import type { BrokerAccount, Signal } from '../types/database'
import { brokersMatchingChannel, getBrokerDisplayLabel } from './brokerChannelLink'
import { formatCopierSkipReasonShort } from './copierLogDetail'
import {
  formatTradeSignalSummary,
  isNonTradeSkipReason,
  type TradeSignalSummaryLabels,
} from './copierLogDisplay'
import { platformIconSrc } from './activityRoute'
import { normalizeSignalSourceKind, SIGNAL_SOURCE_MARKS } from './signalSourceMark'

export type CopierLogRoute = {
  source: string
  sourceIcon: string | null
  destination: string
  destinationIcons: string[]
}

export type CopierLogToast = {
  signalId: string
  status: string
  title: string
  detail: string
  source: string
  sourceIcon: string | null
  destination: string
  destinationIcons: string[]
}

export function copierLogSourceLabel(
  channel: { display_name?: string | null; channel_username?: string | null; source_kind?: string | null } | null | undefined,
  unknownLabel: string,
): string {
  if (!channel) return unknownLabel
  const name = channel.display_name?.trim()
    || (channel.channel_username?.trim() ? `@${channel.channel_username.trim().replace(/^@/, '')}` : '')
  const kind = normalizeSignalSourceKind(channel.source_kind) ?? 'telegram'
  const platform = SIGNAL_SOURCE_MARKS[kind].label
  return name ? `${platform} · ${name}` : platform
}

export function copierLogSourceIcon(
  channel: { source_kind?: string | null } | null | undefined,
): string | null {
  if (!channel) return null
  const kind = normalizeSignalSourceKind(channel.source_kind) ?? 'telegram'
  return SIGNAL_SOURCE_MARKS[kind].iconSrc
}

export function copierLogDestinationLabel(
  brokers: readonly BrokerAccount[],
  channelId: string | null | undefined,
): string {
  return copierLogDestinations(brokers, channelId).map(item => item.label).join(', ')
}

export function copierLogDestinationIcons(
  brokers: readonly BrokerAccount[],
  channelId: string | null | undefined,
): string[] {
  const icons: string[] = []
  for (const item of copierLogDestinations(brokers, channelId)) {
    if (item.iconSrc && !icons.includes(item.iconSrc)) icons.push(item.iconSrc)
  }
  return icons
}

function copierLogDestinations(
  brokers: readonly BrokerAccount[],
  channelId: string | null | undefined,
): Array<{ label: string; iconSrc: string | null }> {
  if (!channelId) return []
  return brokersMatchingChannel([...brokers], channelId.toLowerCase()).map(broker => ({
    label: getBrokerDisplayLabel(broker),
    iconSrc: platformIconSrc(broker.platform ?? ''),
  }))
}

const EMPTY_SYMBOL_CONTEXT = {
  lookup: new Map(),
  replyParentBySignalId: new Map(),
}

export function copierLogToastFingerprint(signal: Pick<Signal, 'id' | 'status' | 'skip_reason'>): string {
  return `${signal.id}|${signal.status}|${signal.skip_reason ?? ''}`
}

export function copierLogToastFromSignal(
  signal: Pick<Signal, 'id' | 'status' | 'skip_reason' | 'parsed_data' | 'raw_message' | 'is_modification' | 'parent_signal_id' | 'channel_id' | 'created_at'>,
  copierLogs: CopierLogsTranslations,
  actionLabels: TradeSignalSummaryLabels,
  route: CopierLogRoute,
): CopierLogToast | null {
  if (isNonTradeSkipReason(signal.skip_reason)) return null
  const title = statusLabel(signal.status, copierLogs)
  const reason = signal.skip_reason ? formatCopierSkipReasonShort(signal.skip_reason, copierLogs) : ''
  const summary = formatTradeSignalSummary(signal, EMPTY_SYMBOL_CONTEXT, [], actionLabels).trim()
  const message = signal.raw_message?.trim() ?? ''
  const detail = (signal.status === 'skipped' || signal.status === 'failed') && reason && reason !== '—'
    ? reason
    : summary && summary !== '—'
      ? summary
      : message.length > 90
        ? `${message.slice(0, 90)}…`
        : message
  return {
    signalId: signal.id,
    status: signal.status,
    title,
    detail: detail || title,
    source: route.source.trim() || '—',
    sourceIcon: route.sourceIcon,
    destination: route.destination.trim() || '—',
    destinationIcons: route.destinationIcons,
  }
}

function statusLabel(status: string, copierLogs: CopierLogsTranslations): string {
  switch (status) {
    case 'executed':
      return copierLogs.statusExecuted
    case 'skipped':
      return copierLogs.statusSkipped
    case 'failed':
      return copierLogs.statusFailed
    case 'pending':
      return copierLogs.statusPending
    case 'parsed':
      return copierLogs.statusParsed
    default:
      return status
  }
}

export function signalHistoryToastLabels(page: SignalHistoryPageTranslations): TradeSignalSummaryLabels {
  return {
    actionBuy: page.actionBuy,
    actionSell: page.actionSell,
    actionClose: page.actionClose,
    actionCloseWorseEntries: page.actionCloseWorseEntries,
    actionBreakeven: page.actionBreakeven,
    actionModify: page.actionModify,
    actionPartialProfit: page.actionPartialProfit,
    actionPartialBreakeven: page.actionPartialBreakeven,
    onSymbol: page.onSymbol,
    entryAt: page.entryAt,
    slAt: page.slAt,
    tpAt: page.tpAt,
  }
}
