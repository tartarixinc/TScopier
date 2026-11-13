import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, ChevronLeft, ChevronRight, Hand, Loader2, RefreshCw, Users } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { en } from '../../i18n/locales/en'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import type { BrokerAccount, Signal } from '../../types/database'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import {
  copierLogDestinationSummary,
  copierLogDestinations,
  copierLogDestinationsFromAccountLabel,
  signalHistoryToastLabels,
  type CopierLogDestination,
} from '../../lib/copierLogToast'
import { CopierDestinationLogos } from '../../components/dashboard/CopierDestinationLogos'
import {
  buildSignalSymbolLookup,
  symbolForCopierLog,
  tradeSignalActionLabel,
  tradeSignalActionToneClass,
  type CopierSymbolContext,
  type TradeSignalSummaryLabels,
} from '../../lib/copierLogDisplay'
import { retrySignalApi } from '../../lib/retrySignalApi'
import {
  formatRetrySignalFailureReason,
  isCopierSignalRetryEligible,
} from '../../lib/retrySignalDisplay'
import {
  buildClosedCopierLogDrafts,
  copierLifecycleLabelsFromCopierLogs,
  resolveCopierDisplayReason,
  resolveCopierDisplayStatus,
  signalStubFromClosedDraft,
  type ClosedTradeForCopierLog,
  type CopierClosedLogDraft,
} from '../../lib/copierLogLifecycle'
import { buildOpenSignalIdSet } from '../../lib/signalOverride'
import { fetchMirrorCopyLogs, pageMirrorSlice, type MirrorCopyLogRow } from '../../lib/mirrorCopyLogs'
import { fetchManualSourceTradeLogs, fetchSocialCopyLogs, type SocialCopyLogRow } from '../../lib/socialCopyLogs'
import { CopierLogDetailModal } from '../../components/dashboard/CopierLogDetailModal'
import { MirrorLogDetailModal } from '../../components/dashboard/MirrorLogDetailModal'
import { SignalSourceLogo } from '../../components/dashboard/SignalSourceLogo'
import { buildChannelSourceKinds, resolveSignalSourceKind, resolveSignalSourceName, SIGNAL_SOURCE_MARKS, type SignalSourceKind } from '../../lib/signalSourceMark'

const DEFAULT_DETAIL_MODAL = en.copierLogs.detailModal!

type Filter = 'all' | 'parsed' | 'executed' | 'open' | 'closed' | 'skipped' | 'failed' | 'pending'

const CLOSED_TRADES_FETCH_LIMIT = 200
const CLOSED_TRADE_SELECT =
  'id,signal_id,telegram_channel_id,symbol,direction,closed_at,close_reason,sl,tp,close_price'

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number]

/** Table column tracks — Destination after Source. */
const COPIER_LOG_GRID =
  'grid grid-cols-[6.75rem_minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(4.75rem,0.75fr)_minmax(0,1.2fr)_minmax(4.5rem,0.7fr)_7.5rem_2.5rem] gap-3 min-w-4xl'

type ChannelNameRow = { id: string; display_name: string; channel_username?: string | null; source_kind?: string | null }

type StatusVariant = 'success' | 'warning' | 'error' | 'neutral' | 'primary'

function isNonTradeSkipReason(value: string | null | undefined): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  return normalized === 'non_trade_message'
}

function buildChannelDisplayNames(channels: ChannelNameRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of channels) {
    const name = c.display_name?.trim()
    const username = c.channel_username?.trim().replace(/^@/, '')
    out[c.id] = name || (username ? `@${username}` : 'Unnamed channel')
  }
  return out
}

/** One rendered log line, whatever produced it (a signal, mirror, social, or manual trade). */
type CopierLogView = {
  symbol: string
  status: { variant: StatusVariant; label: string; className?: string }
  channelName: string
  channelTitle: string
  sourceKind: SignalSourceKind | null
  isMirror: boolean
  isSocial: boolean
  isManual: boolean
  action: string | null
  messageFull: string
  messagePreview: string
  reason: string | null
  reasonShort: string
  timeLabel: string
  destinations: CopierLogDestination[]
}

/** One row on the list — a signal, mirror, social, manual, or synthetic Closed trade. */
type LogViewEntry = { key: string; view: CopierLogView; at: string } & (
  | { signal: Signal; mirror?: never; social?: never; manual?: never; closed?: never }
  | { mirror: MirrorCopyLogRow; signal?: never; social?: never; manual?: never; closed?: never }
  | { social: SocialCopyLogRow; signal?: never; mirror?: never; manual?: never; closed?: never }
  | { manual: SocialCopyLogRow; signal?: never; mirror?: never; social?: never; closed?: never }
  | { closed: CopierClosedLogDraft; signal?: never; mirror?: never; social?: never; manual?: never }
)

/** Where the loaded signal page sits in time, so mirror rows can be spliced in. */
type SignalWindow = {
  /** Page these bounds belong to. */
  page: number
  /** Oldest signal of that page — the next page's exclusive upper bound. */
  oldest: string | null
  /** Bound inherited from the page before it, when the reader paged forward. */
  previousOldest: string | null
}

function formatLogTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shortenReason(reason: string | null | undefined): string | null {
  if (!reason) return null
  return reason.length > 80 ? `${reason.slice(0, 80)}…` : reason
}

function buildSignalLogView(
  signal: Signal,
  channelDisplayNames: Record<string, string>,
  channelSourceKinds: Record<string, SignalSourceKind>,
  symbolContext: CopierSymbolContext,
  batchSignals: Signal[],
  openSignalIds: ReadonlySet<string>,
  statusConfig: Record<string, { variant: StatusVariant; label: string; className?: string }>,
  copierLogs: ReturnType<typeof useT>['copierLogs'],
  brokers: readonly BrokerAccount[] | null | undefined,
): CopierLogView {
  const parsed = signal.parsed_data as Record<string, unknown> | null
  const action = parsed?.action as string | undefined
  const symbol = symbolForCopierLog(signal, symbolContext, batchSignals)
  const displayStatus = resolveCopierDisplayStatus(
    signal.status,
    openSignalIds,
    signal,
    { batchSignals },
  )
  const status = statusConfig[displayStatus] ?? { variant: 'neutral' as const, label: displayStatus }
  const channelName = resolveSignalSourceName(signal, channelDisplayNames, channelSourceKinds)
  const sourceKind = resolveSignalSourceKind(signal, channelSourceKinds)
  const channelTitle = `${SIGNAL_SOURCE_MARKS[sourceKind].label} · ${channelName}`
  const lifecycle = copierLifecycleLabelsFromCopierLogs(copierLogs)
  const reason = resolveCopierDisplayReason(displayStatus, signal.skip_reason, lifecycle, copierLogs)
  const messagePreview = signal.raw_message
    ? (signal.raw_message.length > 60 ? `${signal.raw_message.slice(0, 60)}…` : signal.raw_message)
    : '(image)'

  return {
    symbol,
    status,
    channelName,
    channelTitle,
    sourceKind,
    isMirror: false,
    isSocial: false,
    isManual: false,
    action: action ?? null,
    messageFull: signal.raw_message ?? messagePreview,
    messagePreview,
    reason,
    reasonShort: shortenReason(reason) ?? '—',
    timeLabel: formatLogTime(signal.created_at),
    destinations: copierLogDestinations(brokers, signal.channel_id),
  }
}

function buildClosedLogView(
  draft: CopierClosedLogDraft,
  channelDisplayNames: Record<string, string>,
  channelSourceKinds: Record<string, SignalSourceKind>,
  statusConfig: Record<string, { variant: StatusVariant; label: string; className?: string }>,
  brokers: readonly BrokerAccount[] | null | undefined,
): CopierLogView {
  const channelId = draft.channelId
  const channelName = channelId
    ? (channelDisplayNames[channelId] ?? 'Channel')
    : 'Channel'
  const sourceKind = channelId ? (channelSourceKinds[channelId] ?? null) : null
  const channelTitle = sourceKind
    ? `${SIGNAL_SOURCE_MARKS[sourceKind].label} · ${channelName}`
    : channelName
  return {
    symbol: draft.symbol,
    status: statusConfig.closed ?? { variant: 'neutral' as const, label: 'Closed' },
    channelName,
    channelTitle,
    sourceKind,
    isMirror: false,
    isSocial: false,
    isManual: false,
    action: draft.action,
    messageFull: draft.messageFull,
    messagePreview: draft.messagePreview,
    reason: draft.reason,
    reasonShort: shortenReason(draft.reason) ?? '—',
    timeLabel: formatLogTime(draft.at),
    destinations: copierLogDestinations(brokers, draft.channelId),
  }
}

/** Compose a plain-English one-liner for a mirror-copy event. */
function mirrorLogMessage(
  row: MirrorCopyLogRow,
  copierLogs: ReturnType<typeof useT>['copierLogs'],
): string {
  const vars = {
    // Built from what is actually known: an event with no mapping has no lot
    // and sometimes no side, and must not render "Copied  XAUUSD ( lot)".
    detail: `${[row.side, row.symbol].filter(Boolean).join(' ')}${row.lot == null ? '' : ` (${row.lot} lot)`}`
      || row.action
      || '',
    ticket: row.sourceTicket || '—',
    action: row.action ?? '',
  }
  switch (row.action) {
    case 'open':
      return interpolate(copierLogs.mirrorOpenMessage ?? 'Copied {detail} from master #{ticket}', vars)
    case 'close':
      return interpolate(copierLogs.mirrorCloseMessage ?? 'Copy of #{ticket} closed', vars)
    case 'modify':
      return interpolate(copierLogs.mirrorModifyMessage ?? 'Copy of #{ticket} updated', vars)
    // open | modify | close are the only write actions the engine claims;
    // unsupported and reconcile fall through here (see the action CHECK on
    // mirror_copy_execution_events).
    default:
      return interpolate(copierLogs.mirrorOtherMessage ?? '{action} · copy of #{ticket}', vars)
  }
}

function buildMirrorLogView(
  row: MirrorCopyLogRow,
  statusConfig: Record<string, { variant: StatusVariant; label: string; className?: string }>,
  copierLogs: ReturnType<typeof useT>['copierLogs'],
  brokers: readonly BrokerAccount[] | null | undefined,
): CopierLogView {
  const sourceLabel = copierLogs.mirrorSource
  const message = mirrorLogMessage(row, copierLogs)
  return {
    symbol: row.symbol,
    status: statusConfig[row.status] ?? { variant: 'neutral' as const, label: row.status },
    channelName: `${sourceLabel ?? 'Mirror copy'} · ${row.channelName}`,
    channelTitle: row.channelName,
    sourceKind: null,
    isMirror: true,
    isSocial: false,
    isManual: false,
    action: row.action === 'open' ? (row.side ?? row.action) : row.action,
    messageFull: message,
    messagePreview: message,
    reason: row.reason,
    reasonShort: shortenReason(row.reason) ?? '—',
    timeLabel: formatLogTime(row.createdAt),
    destinations: copierLogDestinationsFromAccountLabel(row.destinationAccount, brokers),
  }
}

/** Compose a plain-English one-liner for a follower social-copy event. */
function socialLogMessage(
  row: SocialCopyLogRow,
  copierLogs: ReturnType<typeof useT>['copierLogs'],
): string {
  const vars = {
    detail: `${[row.side, row.symbol].filter(Boolean).join(' ')}${row.lot == null ? '' : ` (${row.lot} lot)`}`
      || row.action
      || '',
    ticket: row.sourceTicket || '—',
    action: row.action ?? '',
  }
  switch (row.action) {
    case 'open':
      return interpolate(copierLogs.socialOpenMessage ?? 'Copied {detail} from provider #{ticket}', vars)
    case 'close':
      return interpolate(copierLogs.socialCloseMessage ?? 'Social copy of #{ticket} closed', vars)
    case 'modify':
      return interpolate(copierLogs.socialModifyMessage ?? 'Social copy of #{ticket} updated', vars)
    default:
      return interpolate(copierLogs.socialOtherMessage ?? '{action} · social copy of #{ticket}', vars)
  }
}

function buildSocialLogView(
  row: SocialCopyLogRow,
  statusConfig: Record<string, { variant: StatusVariant; label: string; className?: string }>,
  copierLogs: ReturnType<typeof useT>['copierLogs'],
  brokers: readonly BrokerAccount[] | null | undefined,
): CopierLogView {
  const sourceLabel = copierLogs.socialSource
  const message = socialLogMessage(row, copierLogs)
  return {
    symbol: row.symbol,
    status: statusConfig[row.status] ?? { variant: 'neutral' as const, label: row.status },
    channelName: `${sourceLabel ?? 'Social trading'} · ${row.channelName}`,
    channelTitle: row.channelName,
    sourceKind: null,
    isMirror: false,
    isSocial: true,
    isManual: false,
    action: row.action === 'open' ? (row.side ?? row.action) : row.action,
    messageFull: message,
    messagePreview: message,
    reason: row.reason,
    reasonShort: shortenReason(row.reason) ?? '—',
    timeLabel: formatLogTime(row.createdAt),
    destinations: copierLogDestinationsFromAccountLabel(row.destinationAccount, brokers),
  }
}

/** Compose a plain-English one-liner for a provider Manual Execution trade. */
function manualLogMessage(
  row: SocialCopyLogRow,
  copierLogs: ReturnType<typeof useT>['copierLogs'],
): string {
  const vars = {
    detail: `${[row.side, row.symbol].filter(Boolean).join(' ')}${row.lot == null ? '' : ` (${row.lot} lot)`}`
      || row.action
      || '',
    ticket: row.sourceTicket || '—',
    action: row.action ?? '',
  }
  switch (row.action) {
    case 'open':
      return interpolate(copierLogs.manualOpenMessage ?? 'Opened {detail} #{ticket}', vars)
    case 'close':
      return interpolate(copierLogs.manualCloseMessage ?? 'Closed #{ticket}', vars)
    case 'modify':
      return interpolate(copierLogs.manualModifyMessage ?? 'Updated #{ticket}', vars)
    default:
      return interpolate(copierLogs.manualOtherMessage ?? '{action} · #{ticket}', vars)
  }
}

function buildManualLogView(
  row: SocialCopyLogRow,
  statusConfig: Record<string, { variant: StatusVariant; label: string; className?: string }>,
  copierLogs: ReturnType<typeof useT>['copierLogs'],
  brokers: readonly BrokerAccount[] | null | undefined,
): CopierLogView {
  const sourceLabel = copierLogs.manualExecutionSource
  const message = manualLogMessage(row, copierLogs)
  return {
    symbol: row.symbol,
    status: statusConfig[row.status] ?? { variant: 'neutral' as const, label: row.status },
    channelName: `${sourceLabel ?? 'Manual Execution'} · ${row.channelName}`,
    channelTitle: row.channelName,
    sourceKind: null,
    isMirror: false,
    isSocial: false,
    isManual: true,
    action: row.action === 'open' ? (row.side ?? row.action) : row.action,
    messageFull: message,
    messagePreview: message,
    reason: row.reason,
    reasonShort: shortenReason(row.reason) ?? '—',
    timeLabel: formatLogTime(row.createdAt),
    destinations: copierLogDestinationsFromAccountLabel(row.destinationAccount ?? row.channelName, brokers),
  }
}

function DestinationCell({
  destinations,
  className,
}: {
  destinations: readonly CopierLogDestination[]
  className?: string
}) {
  const summary = copierLogDestinationSummary(destinations)
  if (!summary.label || summary.label === '—') {
    return (
      <span className={clsx('min-w-0 text-xs text-neutral-500 dark:text-neutral-400', className)}>—</span>
    )
  }
  return (
    <span
      className={clsx('flex min-w-0 items-center gap-1.5 text-xs text-neutral-900 dark:text-neutral-50', className)}
      title={summary.label}
    >
      <CopierDestinationLogos icons={summary.icons} />
      <span className="min-w-0 truncate">{summary.label}</span>
    </span>
  )
}

function SourceMark({ view, className }: { view: CopierLogView; className?: string }) {
  if (view.isSocial) {
    return (
      <Users
        className={clsx('h-4 w-4 shrink-0 text-neutral-900 dark:text-neutral-50', className)}
        aria-hidden
      />
    )
  }
  if (view.isManual) {
    return (
      <Hand
        className={clsx('h-4 w-4 shrink-0 text-neutral-900 dark:text-neutral-50', className)}
        aria-hidden
      />
    )
  }
  if (view.isMirror) {
    return (
      <ArrowLeftRight
        className={clsx('h-4 w-4 shrink-0 text-neutral-900 dark:text-neutral-50', className)}
        aria-hidden
      />
    )
  }
  return <SignalSourceLogo kind={view.sourceKind} className={className} />
}

function CopierLogCard({
  view,
  labels,
  actionLabels,
  copierLogs,
  isRetrying,
  onRetry,
  onOpenDetail,
}: {
  view: CopierLogView
  labels: { colReason: string; viewDetails: string }
  actionLabels: TradeSignalSummaryLabels
  copierLogs: ReturnType<typeof useT>['copierLogs']
  isRetrying: boolean
  onRetry?: () => void
  onOpenDetail?: () => void
}) {
  const { action, symbol, status, channelName, channelTitle, reason, messagePreview, messageFull, timeLabel, destinations } = view
  const actionLabel = action ? tradeSignalActionLabel(action, actionLabels) : null

  return (
    <article
      className={clsx(
        'px-4 py-4 transition-colors',
        onOpenDetail && 'hover:bg-neutral-50 dark:hover:bg-neutral-800/40 cursor-pointer',
      )}
      onClick={onOpenDetail}
      onKeyDown={onOpenDetail ? e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenDetail()
        }
      } : undefined}
      role={onOpenDetail ? 'button' : undefined}
      tabIndex={onOpenDetail ? 0 : undefined}
      aria-label={onOpenDetail ? labels.viewDetails : undefined}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50 truncate">{symbol}</p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-neutral-900 dark:text-neutral-50" title={channelTitle}>
            <SourceMark view={view} />
            <span className="truncate">{channelName}</span>
          </p>
          <DestinationCell destinations={destinations} className="mt-1" />
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Badge variant={status.variant} size="sm" className={clsx('w-fit', status.className)}>{status.label}</Badge>
          <span className="text-xs text-neutral-900 dark:text-neutral-50 whitespace-nowrap">{timeLabel}</span>
        </div>
      </div>

      {actionLabel ? (
        <p className={clsx(
          'text-sm font-medium mb-3',
          tradeSignalActionToneClass(action),
        )}>
          {actionLabel}
        </p>
      ) : null}

      <p className="text-sm text-neutral-900 dark:text-neutral-50 mb-3 line-clamp-3" title={messageFull}>
        {messagePreview}
      </p>

      {reason !== '—' && reason ? (
        <p className="text-xs text-neutral-900 dark:text-neutral-50 mb-3">
          <span className="font-medium text-neutral-900 dark:text-neutral-50">{labels.colReason}: </span>
          <span className="underline decoration-dotted underline-offset-2">{reason}</span>
        </p>
      ) : null}

      {onRetry ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={isRetrying}
          onClick={e => {
            e.stopPropagation()
            onRetry()
          }}
        >
          {isRetrying ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {copierLogs.retry}
        </Button>
      ) : null}
    </article>
  )
}

function CopierLogRow({
  view,
  actionLabels,
  copierLogs,
  isRetrying,
  onRetry,
  onOpenDetail,
  viewDetailsLabel,
}: {
  view: CopierLogView
  actionLabels: TradeSignalSummaryLabels
  copierLogs: ReturnType<typeof useT>['copierLogs']
  isRetrying: boolean
  onRetry?: () => void
  onOpenDetail?: () => void
  viewDetailsLabel: string
}) {
  const { action, symbol, status, channelName, channelTitle, reasonShort, messagePreview, messageFull, timeLabel, destinations } = view
  const actionLabel = action ? tradeSignalActionLabel(action, actionLabels) : '—'

  return (
    <div
      className={clsx(
        COPIER_LOG_GRID,
        'px-4 sm:px-5 py-3.5 items-center transition-colors',
        onOpenDetail && 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50 cursor-pointer',
      )}
      onClick={onOpenDetail}
      onKeyDown={onOpenDetail ? e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenDetail()
        }
      } : undefined}
      role={onOpenDetail ? 'button' : undefined}
      tabIndex={onOpenDetail ? 0 : undefined}
      aria-label={onOpenDetail ? viewDetailsLabel : undefined}
    >
      <div className="min-w-0 justify-self-start">
        <Badge variant={status.variant} size="sm" className={clsx('w-fit', status.className)}>{status.label}</Badge>
      </div>
      <span className="min-w-0 text-xs text-neutral-900 dark:text-neutral-50 truncate underline decoration-dotted underline-offset-2" title={reasonShort}>
        {reasonShort}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-900 dark:text-neutral-50" title={channelTitle}>
        <SourceMark view={view} />
        <span className="min-w-0 truncate">{channelName}</span>
      </span>
      <DestinationCell destinations={destinations} />
      <span className="min-w-0 text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate" title={symbol}>{symbol}</span>
      <span className="min-w-0 text-xs text-neutral-900 dark:text-neutral-50 truncate" title={messageFull}>
        {messagePreview}
      </span>
      <span className={clsx(
        'min-w-0 text-xs font-medium truncate',
        tradeSignalActionToneClass(action),
      )} title={actionLabel}>
        {actionLabel}
      </span>
      <span className="min-w-0 text-xs text-neutral-900 dark:text-neutral-50 text-right whitespace-nowrap tabular-nums">{timeLabel}</span>
      <div className="flex justify-end">
        {onRetry ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isRetrying}
            onClick={e => {
              e.stopPropagation()
              onRetry()
            }}
            aria-label={copierLogs.retry}
          >
            {isRetrying ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function CopierLogsPage() {
  const t = useT()
  const { user } = useAuth()
  const { brokers } = useBrokerAccounts()
  const [signals, setSignals] = useState<Signal[]>([])
  const [mirrorLogs, setMirrorLogs] = useState<MirrorCopyLogRow[]>([])
  const [socialLogs, setSocialLogs] = useState<SocialCopyLogRow[]>([])
  const [manualLogs, setManualLogs] = useState<SocialCopyLogRow[]>([])
  const [closedTradeDrafts, setClosedTradeDrafts] = useState<CopierClosedLogDraft[]>([])
  const [openSignalIds, setOpenSignalIds] = useState<Set<string>>(() => new Set())
  const [channelDisplayNames, setChannelDisplayNames] = useState<Record<string, string>>({})
  const [channelSourceKinds, setChannelSourceKinds] = useState<Record<string, SignalSourceKind>>({})
  const [symbolContext, setSymbolContext] = useState<CopierSymbolContext>(() => ({
    lookup: new Map(),
    replyParentBySignalId: new Map(),
  }))
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [totalCount, setTotalCount] = useState(0)
  // Signals only (mirrors/social/manual are excluded) — pages are laid out on this count.
  const [signalRowCount, setSignalRowCount] = useState(0)
  // Monotonic token so a slower, older load can never commit over a newer one.
  const loadSeqRef = useRef(0)
  // Where the last loaded signal page ended in time, and the bound inherited
  // from the page before it. Held in state (not a ref) so the render that splices
  // mirror/social/manual rows sees a tracked value rather than a ref read during render.
  const [signalWindow, setSignalWindow] = useState<SignalWindow | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSizeOption>(25)
  const [retryingSignalIds, setRetryingSignalIds] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState<string | null>(null)
  // One slot for the open detail view. A row is a signal, mirror, social, manual, or Closed trade.
  const [detail, setDetail] = useState<LogViewEntry | null>(null)
  const detailSignal = detail?.signal ?? null
  const detailMirror = detail?.mirror ?? null
  const detailSocial = detail?.social ?? null
  const detailManual = detail?.manual ?? null
  const detailClosed = detail?.closed ?? null
  const [closedDetailSignal, setClosedDetailSignal] = useState<Signal | null>(null)
  // Stable identity: MirrorLogDetailModal re-runs its scroll-lock/focus effect
  // whenever this changes, which would yank focus back to the panel.
  const closeDetail = useCallback(() => setDetail(null), [])

  useEffect(() => {
    if (!detailClosed?.signalId || !user?.id) {
      setClosedDetailSignal(null)
      return
    }
    let cancelled = false
    setClosedDetailSignal(null)
    void supabase
      .from('signals')
      .select('*')
      .eq('id', detailClosed.signalId)
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setClosedDetailSignal((data as Signal | null) ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [detailClosed?.signalId, detailClosed?.key, user?.id])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 5000)
  }, [])

  // Pages are counted in signal rows: mirror events ride along inside their
  // signal's span instead of adding pages of their own. Counting them here would
  // create trailing pages with nothing left to show.
  const totalPages = Math.max(1, Math.ceil(signalRowCount / pageSize))
  const isLastSignalPage = page >= totalPages

  useEffect(() => {
    setPage(1)
  }, [filter, pageSize])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const loadSignals = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const seq = ++loadSeqRef.current
    const lifecycle = copierLifecycleLabelsFromCopierLogs(t.copierLogs)

    try {
      // Mirror/social/manual rows carry no signal, so they are read from their own
      // ledgers and spliced into the page that owns their time span.
      const channelsQuery = supabase
        .from('telegram_channels')
        .select('id,display_name,channel_username,source_kind')
        .eq('user_id', user.id)
      const openTradesQuery = supabase
        .from('trades')
        .select('signal_id')
        .eq('user_id', user.id)
        .in('status', ['open', 'pending'])
      const closedTradesQuery = supabase
        .from('trades')
        .select(CLOSED_TRADE_SELECT)
        .eq('user_id', user.id)
        .eq('status', 'closed')
        .not('closed_at', 'is', null)
        .order('closed_at', { ascending: false })
        .limit(CLOSED_TRADES_FETCH_LIMIT)

      const [mirror, social, manual, channelsRes, openTradesRes, closedTradesRes] = await Promise.all([
        fetchMirrorCopyLogs(supabase, user.id),
        fetchSocialCopyLogs(supabase, user.id),
        fetchManualSourceTradeLogs(supabase, user.id).catch(() => [] as SocialCopyLogRow[]),
        channelsQuery,
        openTradesQuery,
        closedTradesQuery,
      ])
      const nextOpenIds = buildOpenSignalIdSet(
        (openTradesRes.data ?? []) as { signal_id?: string | null }[],
      )
      const closedTrades = (closedTradesRes.data ?? []) as ClosedTradeForCopierLog[]
      const closedDrafts = buildClosedCopierLogDrafts(closedTrades, lifecycle)

      const ledgerFilter = filter === 'open' || filter === 'closed' ? null : filter
      const visibleMirror = ledgerFilter === null || ledgerFilter === 'all'
        ? (filter === 'all' ? mirror : [])
        : mirror.filter(row => row.status === ledgerFilter)
      const visibleSocial = ledgerFilter === null || ledgerFilter === 'all'
        ? (filter === 'all' ? social : [])
        : social.filter(row => row.status === ledgerFilter)
      const visibleManual = ledgerFilter === null || ledgerFilter === 'all'
        ? (filter === 'all' ? manual : [])
        : manual.filter(row => row.status === ledgerFilter)

      const from = (page - 1) * pageSize
      const to = from + pageSize - 1

      let loaded: Signal[] = []
      let signalTotal = 0

      if (filter === 'closed') {
        // Closed filter is trade-lifecycle only — paginate synthetic Closed rows.
        const pageDrafts = closedDrafts.slice(from, to + 1)
        signalTotal = closedDrafts.length
        if (seq !== loadSeqRef.current) return
        setSignalWindow({ page, oldest: pageDrafts[pageDrafts.length - 1]?.at ?? null, previousOldest: null })
        setSignalRowCount(signalTotal)
        setMirrorLogs([])
        setSocialLogs([])
        setManualLogs([])
        setClosedTradeDrafts(pageDrafts)
        setOpenSignalIds(nextOpenIds)
        setTotalCount(signalTotal)
        setChannelDisplayNames(buildChannelDisplayNames((channelsRes.data ?? []) as ChannelNameRow[]))
        setChannelSourceKinds(buildChannelSourceKinds((channelsRes.data ?? []) as ChannelNameRow[]))
        setSymbolContext({ lookup: new Map(), replyParentBySignalId: new Map() })
        setSignals([])
        return
      }

      if (filter === 'open') {
        const openIdList = [...nextOpenIds]
        if (openIdList.length === 0) {
          loaded = []
          signalTotal = 0
        } else {
          const openSignalsRes = await supabase
            .from('signals')
            .select('*', { count: 'exact' })
            .eq('user_id', user.id)
            .in('id', openIdList)
            .order('created_at', { ascending: false })
            .range(from, to)
          if (openSignalsRes.error) throw openSignalsRes.error
          loaded = ((openSignalsRes.data ?? []) as Signal[]).filter(s => !isNonTradeSkipReason(s.skip_reason))
          signalTotal = openSignalsRes.count ?? loaded.length
        }
      } else {
        let query = supabase
          .from('signals')
          .select('*', { count: 'exact' })
          .eq('user_id', user.id)
          .or('skip_reason.is.null,skip_reason.neq.non_trade_message')
          .order('created_at', { ascending: false })

        if (filter === 'executed') {
          query = query.eq('status', 'executed')
        } else if (filter !== 'all') {
          query = query.eq('status', filter)
        }
        query = query.range(from, to)

        const signalsRes = await query
        if (signalsRes.error) throw signalsRes.error

        loaded = ((signalsRes.data ?? []) as Signal[]).filter(s => !isNonTradeSkipReason(s.skip_reason))
        if (filter === 'executed') {
          // Open overlay owns those rows under the Open filter.
          loaded = loaded.filter(
            s => resolveCopierDisplayStatus(s.status, nextOpenIds, s, { batchSignals: loaded }) !== 'open',
          )
        }
        const signalsTotal = signalsRes.count ?? loaded.length
        signalTotal = Number.isFinite(signalsTotal) ? signalsTotal : loaded.length
      }

      const nextSymbolContext = await buildSignalSymbolLookup(supabase, user.id, loaded)
      const channelRows = (channelsRes.data ?? []) as ChannelNameRow[]

      if (seq !== loadSeqRef.current) return
      const oldestSignal = loaded[loaded.length - 1]?.created_at ?? null
      setSignalWindow(prev => ({
        page,
        oldest: oldestSignal ?? prev?.oldest ?? null,
        previousOldest: prev && prev.page === page - 1 ? prev.oldest : null,
      }))
      setSignalRowCount(signalTotal)
      setMirrorLogs(visibleMirror)
      setSocialLogs(visibleSocial)
      setManualLogs(visibleManual)
      setClosedTradeDrafts(filter === 'all' ? closedDrafts : [])
      setOpenSignalIds(nextOpenIds)
      setTotalCount(
        signalTotal
        + visibleMirror.length
        + visibleSocial.length
        + visibleManual.length
        + (filter === 'all' ? closedDrafts.length : 0),
      )
      setChannelDisplayNames(buildChannelDisplayNames(channelRows))
      setChannelSourceKinds(buildChannelSourceKinds(channelRows))
      setSymbolContext(nextSymbolContext)
      setSignals(loaded)
    } catch (error) {
      // Never leave the skeleton up: the next load recovers from a failed one.
      console.warn('[copier-logs] load failed:', error instanceof Error ? error.message : String(error))
    } finally {
      // Only the load that still owns the token may clear the flag, so a
      // superseded request cannot switch off a newer one's loading state.
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [user, filter, page, pageSize, t.copierLogs])

  const retrySignalEntry = useCallback(async (signalId: string) => {
    setRetryingSignalIds(prev => new Set(prev).add(signalId))
    try {
      const result = await retrySignalApi.retry(signalId)
      if (!result.ok) {
        showToast(formatRetrySignalFailureReason(result.reason, t.copierLogs))
        return
      }
      showToast(t.copierLogs.retrySuccess)
      await loadSignals()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.copierLogs.retryFailedGeneric)
    } finally {
      setRetryingSignalIds(prev => {
        const next = new Set(prev)
        next.delete(signalId)
        return next
      })
    }
  }, [loadSignals, showToast, t.copierLogs])

  useEffect(() => {
    if (!user) return
    void loadSignals()
  }, [user, loadSignals])

  const filters: { value: Filter; label: string }[] = useMemo(
    () => [
      { value: 'all', label: t.copierLogs.filterAll },
      { value: 'parsed', label: t.copierLogs.statusParsed },
      { value: 'executed', label: t.copierLogs.filterExecuted },
      { value: 'open', label: t.copierLogs.filterOpen },
      { value: 'skipped', label: t.copierLogs.filterSkipped },
      { value: 'failed', label: t.copierLogs.filterFailed },
      { value: 'closed', label: t.copierLogs.filterClosed },
    ],
    [t],
  )

  const statusConfig: Record<string, { variant: StatusVariant; label: string; className?: string }> = useMemo(
    () => ({
      executed: { variant: 'success', label: t.copierLogs.statusExecuted, className: 'bg-green-100 text-neutral-950 dark:bg-green-100 dark:text-neutral-950' },
      open: { variant: 'success', label: t.copierLogs.statusOpen, className: 'bg-teal-100 text-teal-900 dark:bg-teal-900/50 dark:text-teal-200' },
      closed: { variant: 'neutral', label: t.copierLogs.statusClosed },
      skipped: { variant: 'warning', label: t.copierLogs.statusSkipped },
      failed: { variant: 'error', label: t.copierLogs.statusFailed },
      pending: { variant: 'neutral', label: t.copierLogs.statusPending },
      parsed: { variant: 'primary', label: t.copierLogs.statusParsed },
    }),
    [t],
  )

  const cardLabels = useMemo(
    () => ({
      colReason: t.copierLogs.colReason,
      viewDetails: t.copierLogs.detailModal?.viewDetails ?? DEFAULT_DETAIL_MODAL.viewDetails,
    }),
    [t],
  )

  const actionLabels = useMemo(
    () => signalHistoryToastLabels(t.signalHistoryPage),
    [t.signalHistoryPage],
  )

  const viewDetailsLabel = t.copierLogs.detailModal?.viewDetails ?? DEFAULT_DETAIL_MODAL.viewDetails

  /**
   * One page of the log: this page's signals, with the mirror/social/manual events that
   * share their time span spliced in, newest first. Extra events never sit in
   * front of every signal — they appear in the page that owns their moment.
   */
  const logViews = useMemo((): LogViewEntry[] => {
    if (filter === 'closed') {
      return closedTradeDrafts.map((draft): LogViewEntry => ({
        key: draft.key,
        at: draft.at,
        view: buildClosedLogView(draft, channelDisplayNames, channelSourceKinds, statusConfig, brokers),
        closed: draft,
      }))
    }
    const bound = signalWindow && signalWindow.page === page ? signalWindow.previousOldest : null
    const mirrorRows = pageMirrorSlice(mirrorLogs, signals, page, bound, isLastSignalPage)
    const socialRows = pageMirrorSlice(socialLogs, signals, page, bound, isLastSignalPage)
    const manualRows = pageMirrorSlice(manualLogs, signals, page, bound, isLastSignalPage)
    const closedForPage = filter === 'all'
      ? pageMirrorSlice(
        closedTradeDrafts.map(d => ({ ...d, createdAt: d.at })),
        signals,
        page,
        bound,
        isLastSignalPage,
      )
      : []
    const entries: LogViewEntry[] = [
      ...mirrorRows.map(row => ({
        key: row.id,
        at: row.createdAt,
        view: buildMirrorLogView(row, statusConfig, t.copierLogs, brokers),
        mirror: row,
      })),
      ...socialRows.map(row => ({
        key: row.id,
        at: row.createdAt,
        view: buildSocialLogView(row, statusConfig, t.copierLogs, brokers),
        social: row,
      })),
      ...manualRows.map(row => ({
        key: row.id,
        at: row.createdAt,
        view: buildManualLogView(row, statusConfig, t.copierLogs, brokers),
        manual: row,
      })),
      ...closedForPage.map(draft => ({
        key: draft.key,
        at: draft.at,
        view: buildClosedLogView(draft, channelDisplayNames, channelSourceKinds, statusConfig, brokers),
        closed: draft,
      })),
      ...signals.map(signal => ({
        key: signal.id,
        at: signal.created_at,
        view: buildSignalLogView(
          signal,
          channelDisplayNames,
          channelSourceKinds,
          symbolContext,
          signals,
          openSignalIds,
          statusConfig,
          t.copierLogs,
          brokers,
        ),
        signal,
      })),
    ]
    return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }, [
    filter,
    closedTradeDrafts,
    mirrorLogs,
    socialLogs,
    manualLogs,
    signals,
    openSignalIds,
    page,
    signalWindow,
    isLastSignalPage,
    statusConfig,
    channelDisplayNames,
    channelSourceKinds,
    symbolContext,
    brokers,
    t,
  ])

  // Positions are counted in signal rows, but a page can carry more rows than
  // the page size once mirror events splice in, so the end of the range comes
  // from what is actually on screen rather than from `page * pageSize`. The two
  // numbers are therefore approximate when mirrors span several pages: the total
  // is exact (every row is reachable exactly once), the window is not.
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = totalCount === 0
    ? 0
    : Math.max(rangeStart, Math.min(rangeStart + logViews.length - 1, totalCount))

  const detailDisplay = useMemo(() => {
    if (!detailSignal) return null
    const displayStatus = resolveCopierDisplayStatus(
      detailSignal.status,
      openSignalIds,
      detailSignal,
      { batchSignals: signals },
    )
    const status = statusConfig[displayStatus] ?? { variant: 'neutral' as const, label: displayStatus }
    return {
      signal: detailSignal,
      channelName: resolveSignalSourceName(detailSignal, channelDisplayNames, channelSourceKinds),
      sourceKind: resolveSignalSourceKind(detailSignal, channelSourceKinds),
      symbol: symbolForCopierLog(detailSignal, symbolContext, signals),
      status,
      displayStatus,
      reason: resolveCopierDisplayReason(
        displayStatus,
        detailSignal.skip_reason,
        copierLifecycleLabelsFromCopierLogs(t.copierLogs),
        t.copierLogs,
      ),
      destinations: detail?.view.destinations ?? copierLogDestinations(brokers, detailSignal.channel_id),
    }
  }, [detailSignal, detail?.view.destinations, openSignalIds, statusConfig, channelDisplayNames, channelSourceKinds, symbolContext, signals, brokers, t.copierLogs])

  const closedDetailDisplay = useMemo(() => {
    if (!detailClosed || !user?.id) return null
    const stub = signalStubFromClosedDraft(detailClosed, user.id)
    const signal = closedDetailSignal ?? stub
    const channelName = detailClosed.channelId
      ? (channelDisplayNames[detailClosed.channelId] ?? detail?.view.channelName ?? 'Channel')
      : (detail?.view.channelName ?? 'Channel')
    const sourceKind = detailClosed.channelId
      ? (channelSourceKinds[detailClosed.channelId] ?? detail?.view.sourceKind ?? null)
      : (detail?.view.sourceKind ?? null)
    return {
      signal,
      channelName,
      sourceKind,
      symbol: detailClosed.symbol,
      status: statusConfig.closed ?? { variant: 'neutral' as const, label: t.copierLogs.statusClosed },
      reason: detailClosed.reason,
      destinations: detail?.view.destinations ?? copierLogDestinations(brokers, detailClosed.channelId),
      closedAt: detailClosed.at,
    }
  }, [
    detailClosed,
    closedDetailSignal,
    user?.id,
    channelDisplayNames,
    channelSourceKinds,
    detail?.view.channelName,
    detail?.view.sourceKind,
    detail?.view.destinations,
    statusConfig,
    brokers,
    t.copierLogs.statusClosed,
  ])

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      {toast ? (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg bg-neutral-900 text-white text-sm px-4 py-3 shadow-lg">
          {toast}
        </div>
      ) : null}
      <PageHeader
        title={t.copierLogs.title}
        actions={(
          <div className="-mx-4 w-full overflow-x-auto px-4 sm:mx-0 sm:w-auto sm:px-0">
          <div className="inline-flex bg-white dark:bg-neutral-900 border border-neutral-200/65 dark:border-neutral-800/55 rounded-lg p-0.5 gap-0.5">
            {filters.map(f => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={`shrink-0 px-3 py-2 text-xs rounded-md font-medium transition-colors whitespace-nowrap ${
                  filter === f.value ? 'bg-green-400 text-neutral-950' : 'text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          </div>
        )}
      />

      <Card padding="none" className="overflow-hidden">
        {loading ? (
          <>
            <div className="md:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="px-4 py-4 space-y-3">
                  <div className="flex justify-between gap-3">
                    <div className="h-5 w-20 bg-neutral-100 dark:bg-neutral-800 rounded-sm animate-pulse" />
                    <div className="h-5 w-16 bg-neutral-100 dark:bg-neutral-800 rounded-sm animate-pulse" />
                  </div>
                  <div className="h-4 w-full bg-neutral-100 dark:bg-neutral-800 rounded-sm animate-pulse" />
                  <div className="h-4 w-3/4 bg-neutral-100 dark:bg-neutral-800 rounded-sm animate-pulse" />
                </div>
              ))}
            </div>
            <div className="hidden md:block divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(pageSize > 6 ? 6 : pageSize)].map((_, i) => (
                <div key={i} className={`px-5 py-3.5 ${COPIER_LOG_GRID}`}>
                  {[...Array(9)].map((_, j) => (
                    <div key={j} className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded-sm animate-pulse" />
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : logViews.length === 0 ? (
          <div className="px-4 sm:px-6 py-12 sm:py-20 text-center">
            <div className="w-16 h-16 bg-neutral-100 dark:bg-neutral-800 rounded-2xl mx-auto mb-3 flex items-center justify-center">
              <svg className="w-8 h-8 text-neutral-900 dark:text-neutral-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{t.copierLogs.emptyTitle}</p>
            <p className="text-xs text-neutral-900 dark:text-neutral-50 mt-1">{t.copierLogs.emptySubtitle}</p>
          </div>
        ) : (
          <>
            <div className="md:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {logViews.map(entry => {
                const signal = 'signal' in entry ? entry.signal : undefined
                return (
                  <CopierLogCard
                    key={entry.key}
                    view={entry.view}
                    labels={cardLabels}
                    actionLabels={actionLabels}
                    copierLogs={t.copierLogs}
                    isRetrying={signal ? retryingSignalIds.has(signal.id) : false}
                    onRetry={signal && isCopierSignalRetryEligible(signal)
                      ? () => { void retrySignalEntry(signal.id) }
                      : undefined}
                    onOpenDetail={() => setDetail(entry)}
                  />
                )
              })}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <div className={`${COPIER_LOG_GRID} px-4 sm:px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-semibold text-neutral-900 dark:text-neutral-50 uppercase tracking-wide`}>
                <span className="min-w-0">{t.copierLogs.colStatus}</span>
                <span className="min-w-0">{t.copierLogs.colReason}</span>
                <span className="min-w-0">{t.copierLogs.colChannel}</span>
                <span className="min-w-0">{t.copierLogs.colDestination}</span>
                <span className="min-w-0">{t.copierLogs.colSymbol}</span>
                <span className="min-w-0">{t.copierLogs.colMessage}</span>
                <span className="min-w-0">{t.copierLogs.colType}</span>
                <span className="min-w-0 text-right">{t.copierLogs.colTime}</span>
                <span />
              </div>
              <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {logViews.map(entry => {
                  const signal = 'signal' in entry ? entry.signal : undefined
                  return (
                    <CopierLogRow
                      key={entry.key}
                      view={entry.view}
                      actionLabels={actionLabels}
                      copierLogs={t.copierLogs}
                      isRetrying={signal ? retryingSignalIds.has(signal.id) : false}
                      onRetry={signal && isCopierSignalRetryEligible(signal)
                        ? () => { void retrySignalEntry(signal.id) }
                        : undefined}
                      onOpenDetail={() => setDetail(entry)}
                      viewDetailsLabel={viewDetailsLabel}
                    />
                  )
                })}
              </div>
            </div>
          </>
        )}

        {!loading && totalCount > 0 ? (
          <CopierLogsPagination
            page={page}
            pageSize={pageSize}
            totalPages={totalPages}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={totalCount}
            onPageChange={(next) => {
              setPage(next)
              // Raise the skeleton in the same tick as the navigation. Effects run
              // after paint, so without this one frame would show the new page
              // number paired with the previous page's rows.
              setLoading(true)
            }}
            onPageSizeChange={setPageSize}
            labels={{
              show: t.common.show,
              results: t.common.results,
              previous: t.common.previous,
              next: t.common.next,
              showingRange: (start, end, total) =>
                interpolate(t.common.showingRange, { start, end, total }),
            }}
          />
        ) : null}
      </Card>

      {detailDisplay && !detailClosed ? (
        <CopierLogDetailModal
          signal={detailDisplay.signal}
          channelName={detailDisplay.channelName}
          sourceKind={detailDisplay.sourceKind}
          symbol={detailDisplay.symbol}
          status={detailDisplay.status}
          displayReason={detailDisplay.reason}
          destinations={detailDisplay.destinations}
          onClose={closeDetail}
          retryEligible={isCopierSignalRetryEligible(detailDisplay.signal)}
          isRetrying={retryingSignalIds.has(detailDisplay.signal.id)}
          onRetry={isCopierSignalRetryEligible(detailDisplay.signal)
            ? () => { void retrySignalEntry(detailDisplay.signal.id) }
            : undefined}
        />
      ) : null}

      {closedDetailDisplay ? (
        <CopierLogDetailModal
          signal={closedDetailDisplay.signal}
          channelName={closedDetailDisplay.channelName}
          sourceKind={closedDetailDisplay.sourceKind}
          symbol={closedDetailDisplay.symbol}
          status={closedDetailDisplay.status}
          displayReason={closedDetailDisplay.reason}
          destinations={closedDetailDisplay.destinations}
          closedAt={closedDetailDisplay.closedAt}
          onClose={closeDetail}
          retryEligible={false}
        />
      ) : null}

      {detailMirror ? (
        <MirrorLogDetailModal
          row={detailMirror}
          status={statusConfig[detailMirror.status] ?? { variant: 'neutral' as const, label: detailMirror.status }}
          onClose={closeDetail}
          variant="mirror"
        />
      ) : null}

      {detailSocial ? (
        <MirrorLogDetailModal
          row={detailSocial}
          status={statusConfig[detailSocial.status] ?? { variant: 'neutral' as const, label: detailSocial.status }}
          onClose={closeDetail}
          variant="social"
        />
      ) : null}

      {detailManual ? (
        <MirrorLogDetailModal
          row={detailManual}
          status={statusConfig[detailManual.status] ?? { variant: 'neutral' as const, label: detailManual.status }}
          onClose={closeDetail}
          variant="manual"
        />
      ) : null}
    </PageShell>
  )
}

function CopierLogsPagination({
  page,
  pageSize,
  totalPages,
  rangeStart,
  rangeEnd,
  total,
  onPageChange,
  onPageSizeChange,
  labels,
}: {
  page: number
  pageSize: PageSizeOption
  totalPages: number
  rangeStart: number
  rangeEnd: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: PageSizeOption) => void
  labels: {
    show: string
    results: string
    previous: string
    next: string
    showingRange: (start: number, end: number, total: number) => string
  }
}) {
  const pageNumbers = useMemo(() => {
    const maxButtons = 5
    if (totalPages <= maxButtons) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }
    let start = Math.max(1, page - 2)
    let end = Math.min(totalPages, start + maxButtons - 1)
    start = Math.max(1, end - maxButtons + 1)
    return Array.from({ length: end - start + 1 }, (_, i) => start + i)
  }, [page, totalPages])

  return (
    <div className="flex flex-col gap-3 px-3 sm:px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="inline-flex items-center gap-2 text-sm text-neutral-900 dark:text-neutral-50">
          <span className="font-medium text-neutral-900 dark:text-neutral-50">{labels.show}</span>
          <select
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value) as PageSizeOption)}
            className="h-8 min-w-18 rounded-md border border-neutral-200/65 dark:border-neutral-800/55 bg-white dark:bg-neutral-900 px-2 text-sm text-neutral-900 dark:text-neutral-50 tabular-nums focus:outline-hidden focus:ring-2 focus:ring-green-400 focus:border-transparent"
            aria-label="Results per page"
          >
            {PAGE_SIZE_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span>{labels.results}</span>
        </label>
        <p className="text-xs text-neutral-900 dark:text-neutral-50 tabular-nums">
          {labels.showingRange(rangeStart, rangeEnd, total)}
        </p>
      </div>
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-1 justify-center sm:justify-end">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200/65 dark:border-neutral-800/55 text-neutral-900 dark:text-neutral-50 hover:bg-white dark:hover:bg-neutral-900 disabled:opacity-40 disabled:pointer-events-none"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden sm:inline">{labels.previous}</span>
          </button>
          <div className="flex items-center gap-0.5">
            {pageNumbers[0]! > 1 && (
              <>
                <PageButton n={1} active={page === 1} onClick={() => onPageChange(1)} />
                {pageNumbers[0]! > 2 && <span className="px-1 text-neutral-900 dark:text-neutral-50 text-sm">…</span>}
              </>
            )}
            {pageNumbers.map(n => (
              <PageButton key={n} n={n} active={page === n} onClick={() => onPageChange(n)} />
            ))}
            {pageNumbers[pageNumbers.length - 1]! < totalPages && (
              <>
                {pageNumbers[pageNumbers.length - 1]! < totalPages - 1 && (
                  <span className="px-1 text-neutral-900 dark:text-neutral-50 text-sm">…</span>
                )}
                <PageButton n={totalPages} active={page === totalPages} onClick={() => onPageChange(totalPages)} />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200/65 dark:border-neutral-800/55 text-neutral-900 dark:text-neutral-50 hover:bg-white dark:hover:bg-neutral-900 disabled:opacity-40 disabled:pointer-events-none"
            aria-label="Next page"
          >
            <span className="hidden sm:inline">{labels.next}</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}

function PageButton({ n, active, onClick }: { n: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`min-w-8 px-2 py-1.5 text-sm rounded-md font-medium tabular-nums transition-colors ${
        active
          ? 'bg-green-400 text-neutral-950'
          : 'text-neutral-900 dark:text-neutral-50 hover:bg-white dark:hover:bg-neutral-900 border border-transparent hover:border-neutral-200 dark:hover:border-neutral-800'
      }`}
    >
      {n}
    </button>
  )
}
