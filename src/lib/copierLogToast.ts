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

/** Seed/merge fingerprints so refresh + non-status updates (e.g. reconcile) do not re-toast. */
export function mergeCopierLogToastSeen(
  seen: Map<string, string>,
  rows: Array<Pick<Signal, 'id' | 'status' | 'skip_reason'>>,
): void {
  for (const row of rows) {
    seen.set(row.id, copierLogToastFingerprint(row))
  }
}

const SEEN_STORAGE_PREFIX = 'tsc_copier_log_toasts_seen:'
const SEEN_STORAGE_MAX = 200

export function readCopierLogToastSeen(userId: string): Map<string, string> {
  if (typeof sessionStorage === 'undefined') return new Map()
  try {
    const raw = sessionStorage.getItem(`${SEEN_STORAGE_PREFIX}${userId}`)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Map()
    const out = new Map<string, string>()
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const id = entry[0]
      const fingerprint = entry[1]
      if (typeof id === 'string' && typeof fingerprint === 'string') out.set(id, fingerprint)
    }
    return out
  } catch {
    return new Map()
  }
}

export function writeCopierLogToastSeen(userId: string, seen: Map<string, string>): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    const entries = [...seen.entries()].slice(-SEEN_STORAGE_MAX)
    sessionStorage.setItem(`${SEEN_STORAGE_PREFIX}${userId}`, JSON.stringify(entries))
  } catch {
    // Quota / private mode — in-memory seen still works for this page life.
  }
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
