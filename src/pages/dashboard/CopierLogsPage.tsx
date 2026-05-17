import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import type { Signal } from '../../types/database'
import {
  buildSignalSymbolLookup,
  symbolForCopierLog,
  type SignalSymbolLookupRow,
} from '../../lib/copierLogDisplay'

type Filter = 'all' | 'executed' | 'skipped' | 'failed' | 'pending'

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number]

type ChannelNameRow = { id: string; display_name: string; channel_username?: string | null }

type StatusVariant = 'success' | 'warning' | 'error' | 'neutral' | 'primary'

function buildChannelDisplayNames(channels: ChannelNameRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of channels) {
    const name = c.display_name?.trim()
    const username = c.channel_username?.trim().replace(/^@/, '')
    out[c.id] = name || (username ? `@${username}` : 'Unnamed channel')
  }
  return out
}

function channelLabel(channelId: string | null | undefined, names: Record<string, string>): string {
  if (!channelId) return '—'
  return names[channelId] ?? 'Unknown channel'
}

function useCopierLogDisplay(
  signal: Signal,
  channelDisplayNames: Record<string, string>,
  symbolLookup: Map<string, SignalSymbolLookupRow>,
  statusConfig: Record<string, { variant: StatusVariant; label: string }>,
) {
  const parsed = signal.parsed_data as Record<string, unknown> | null
  const action = parsed?.action as string | undefined
  const symbol = symbolForCopierLog(signal, symbolLookup)
  const status = statusConfig[signal.status] ?? { variant: 'neutral' as const, label: signal.status }
  const channelName = channelLabel(signal.channel_id, channelDisplayNames)
  const reason = signal.skip_reason?.trim() || '—'
  const reasonShort = signal.skip_reason
    ? (signal.skip_reason.length > 42 ? `${signal.skip_reason.slice(0, 42)}…` : signal.skip_reason)
    : '—'
  const messagePreview = signal.raw_message
    ? (signal.raw_message.length > 60 ? `${signal.raw_message.slice(0, 60)}…` : signal.raw_message)
    : '(image)'
  const timeLabel = new Date(signal.created_at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return { action, symbol, status, channelName, reason, reasonShort, messagePreview, timeLabel }
}

function CopierLogCard({
  signal,
  channelDisplayNames,
  symbolLookup,
  statusConfig,
  labels,
}: {
  signal: Signal
  channelDisplayNames: Record<string, string>
  symbolLookup: Map<string, SignalSymbolLookupRow>
  statusConfig: Record<string, { variant: StatusVariant; label: string }>
  labels: { colReason: string }
}) {
  const { action, symbol, status, channelName, reason, messagePreview, timeLabel } = useCopierLogDisplay(
    signal,
    channelDisplayNames,
    symbolLookup,
    statusConfig,
  )

  return (
    <article className="px-4 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50 truncate">{symbol}</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5" title={channelName}>
            {channelName}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Badge variant={status.variant} size="sm">{status.label}</Badge>
          <span className="text-xs text-neutral-400 whitespace-nowrap">{timeLabel}</span>
        </div>
      </div>

      {action ? (
        <p className={clsx(
          'text-sm font-medium uppercase mb-3',
          action === 'buy' ? 'text-primary-600' : action === 'sell' ? 'text-error-600' : 'text-neutral-400',
        )}>
          {action}
        </p>
      ) : null}

      <p className="text-sm text-neutral-600 dark:text-neutral-300 mb-3 line-clamp-3" title={signal.raw_message ?? ''}>
        {messagePreview}
      </p>

      {reason !== '—' ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400" title={signal.skip_reason ?? ''}>
          <span className="font-medium text-neutral-600 dark:text-neutral-300">{labels.colReason}: </span>
          {reason}
        </p>
      ) : null}
    </article>
  )
}

function CopierLogRow({
  signal,
  channelDisplayNames,
  symbolLookup,
  statusConfig,
}: {
  signal: Signal
  channelDisplayNames: Record<string, string>
  symbolLookup: Map<string, SignalSymbolLookupRow>
  statusConfig: Record<string, { variant: StatusVariant; label: string }>
}) {
  const { action, symbol, status, channelName, reasonShort, messagePreview, timeLabel } = useCopierLogDisplay(
    signal,
    channelDisplayNames,
    symbolLookup,
    statusConfig,
  )

  return (
    <div className="grid grid-cols-[1.5fr_1.2fr_1fr_1.2fr_1fr_1fr_auto] gap-3 min-w-[44rem] px-4 sm:px-5 py-3.5 items-center hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
      <Badge variant={status.variant} size="sm">{status.label}</Badge>
      <span className="text-xs text-neutral-500 dark:text-neutral-400 truncate" title={signal.skip_reason ?? ''}>
        {reasonShort}
      </span>
      <span className="text-xs text-neutral-600 dark:text-neutral-400 truncate" title={channelName}>
        {channelName}
      </span>
      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{symbol}</span>
      <span className="text-xs text-neutral-500 dark:text-neutral-400 truncate" title={signal.raw_message ?? ''}>
        {messagePreview}
      </span>
      <span className={clsx(
        'text-xs font-medium uppercase',
        action === 'buy' ? 'text-primary-600' : action === 'sell' ? 'text-error-600' : 'text-neutral-400',
      )}>
        {action ?? '—'}
      </span>
      <span className="text-xs text-neutral-400 text-right whitespace-nowrap">{timeLabel}</span>
    </div>
  )
}

export function CopierLogsPage() {
  const t = useT()
  const { user } = useAuth()
  const [signals, setSignals] = useState<Signal[]>([])
  const [channelDisplayNames, setChannelDisplayNames] = useState<Record<string, string>>({})
  const [symbolLookup, setSymbolLookup] = useState<Map<string, SignalSymbolLookupRow>>(() => new Map())
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSizeOption>(25)

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  useEffect(() => {
    setPage(1)
  }, [filter, pageSize])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const loadSignals = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let query = supabase
      .from('signals')
      .select('*', { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (filter !== 'all') query = query.eq('status', filter)

    const [channelsRes, signalsRes] = await Promise.all([
      supabase
        .from('telegram_channels')
        .select('id,display_name,channel_username')
        .eq('user_id', user.id),
      query,
    ])

    const loaded = (signalsRes.data ?? []) as Signal[]
    setTotalCount(signalsRes.count ?? loaded.length)
    setChannelDisplayNames(buildChannelDisplayNames((channelsRes.data ?? []) as ChannelNameRow[]))
    setSymbolLookup(await buildSignalSymbolLookup(supabase, user.id, loaded))
    setSignals(loaded)
    setLoading(false)
  }, [user, filter, page, pageSize])

  useEffect(() => {
    if (!user) return
    void loadSignals()
  }, [user, loadSignals])

  const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = Math.min(page * pageSize, totalCount)

  const filters: { value: Filter; label: string }[] = useMemo(
    () => [
      { value: 'all', label: t.copierLogs.filterAll },
      { value: 'executed', label: t.copierLogs.filterExecuted },
      { value: 'skipped', label: t.copierLogs.filterSkipped },
      { value: 'failed', label: t.copierLogs.filterFailed },
      { value: 'pending', label: t.copierLogs.filterPending },
    ],
    [t],
  )

  const statusConfig: Record<string, { variant: StatusVariant; label: string }> = useMemo(
    () => ({
      executed: { variant: 'success', label: t.copierLogs.statusExecuted },
      skipped: { variant: 'warning', label: t.copierLogs.statusSkipped },
      failed: { variant: 'error', label: t.copierLogs.statusFailed },
      pending: { variant: 'neutral', label: t.copierLogs.statusPending },
      parsed: { variant: 'primary', label: t.copierLogs.statusParsed },
    }),
    [t],
  )

  const cardLabels = useMemo(() => ({ colReason: t.copierLogs.colReason }), [t])

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6 lg:p-8 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 sm:mb-6 gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-neutral-900 dark:text-neutral-50">{t.copierLogs.title}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{t.copierLogs.subtitle}</p>
        </div>
        <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto w-full sm:w-auto">
          <div className="inline-flex bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-0.5 gap-0.5">
            {filters.map(f => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={`shrink-0 px-3 py-2 text-xs rounded-md font-medium transition-colors whitespace-nowrap ${
                  filter === f.value ? 'bg-teal-600 text-white' : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Card padding="none" className="overflow-hidden">
        {loading ? (
          <>
            <div className="md:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="px-4 py-4 space-y-3">
                  <div className="flex justify-between gap-3">
                    <div className="h-5 w-20 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                    <div className="h-5 w-16 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                  </div>
                  <div className="h-4 w-full bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                  <div className="h-4 w-3/4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                </div>
              ))}
            </div>
            <div className="hidden md:block divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(pageSize > 6 ? 6 : pageSize)].map((_, i) => (
                <div key={i} className="px-5 py-3.5 grid grid-cols-7 gap-3">
                  {[...Array(7)].map((_, j) => (
                    <div key={j} className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : signals.length === 0 ? (
          <div className="px-4 sm:px-6 py-12 sm:py-20 text-center">
            <div className="w-16 h-16 bg-neutral-100 dark:bg-neutral-800 rounded-2xl mx-auto mb-3 flex items-center justify-center">
              <svg className="w-8 h-8 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-neutral-400">{t.copierLogs.emptyTitle}</p>
            <p className="text-xs text-neutral-300 mt-1">{t.copierLogs.emptySubtitle}</p>
          </div>
        ) : (
          <>
            <div className="md:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {signals.map(signal => (
                <CopierLogCard
                  key={signal.id}
                  signal={signal}
                  channelDisplayNames={channelDisplayNames}
                  symbolLookup={symbolLookup}
                  statusConfig={statusConfig}
                  labels={cardLabels}
                />
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <div className="grid grid-cols-[1.5fr_1.2fr_1fr_1.2fr_1fr_1fr_auto] gap-3 min-w-[44rem] px-4 sm:px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-semibold text-neutral-400 uppercase tracking-wide">
                <span>{t.copierLogs.colStatus}</span>
                <span>{t.copierLogs.colReason}</span>
                <span>{t.copierLogs.colChannel}</span>
                <span>{t.copierLogs.colSymbol}</span>
                <span>{t.copierLogs.colMessage}</span>
                <span>{t.copierLogs.colType}</span>
                <span className="text-right">{t.copierLogs.colTime}</span>
              </div>
              <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {signals.map(signal => (
                  <CopierLogRow
                    key={signal.id}
                    signal={signal}
                    channelDisplayNames={channelDisplayNames}
                    symbolLookup={symbolLookup}
                    statusConfig={statusConfig}
                  />
                ))}
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
            onPageChange={setPage}
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
    </div>
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
        <label className="inline-flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{labels.show}</span>
          <select
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value) as PageSizeOption)}
            className="h-8 min-w-[4.5rem] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-2 text-sm text-neutral-900 dark:text-neutral-50 tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
            aria-label="Results per page"
          >
            {PAGE_SIZE_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span>{labels.results}</span>
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
          {labels.showingRange(rangeStart, rangeEnd, total)}
        </p>
      </div>
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-1 justify-center sm:justify-end">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-white dark:hover:bg-neutral-900 disabled:opacity-40 disabled:pointer-events-none"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden sm:inline">{labels.previous}</span>
          </button>
          <div className="flex items-center gap-0.5">
            {pageNumbers[0]! > 1 && (
              <>
                <PageButton n={1} active={page === 1} onClick={() => onPageChange(1)} />
                {pageNumbers[0]! > 2 && <span className="px-1 text-neutral-400 text-sm">…</span>}
              </>
            )}
            {pageNumbers.map(n => (
              <PageButton key={n} n={n} active={page === n} onClick={() => onPageChange(n)} />
            ))}
            {pageNumbers[pageNumbers.length - 1]! < totalPages && (
              <>
                {pageNumbers[pageNumbers.length - 1]! < totalPages - 1 && (
                  <span className="px-1 text-neutral-400 text-sm">…</span>
                )}
                <PageButton n={totalPages} active={page === totalPages} onClick={() => onPageChange(totalPages)} />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-white dark:hover:bg-neutral-900 disabled:opacity-40 disabled:pointer-events-none"
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
      className={`min-w-[2rem] px-2 py-1.5 text-sm rounded-md font-medium tabular-nums transition-colors ${
        active
          ? 'bg-teal-600 text-white'
          : 'text-neutral-600 dark:text-neutral-400 hover:bg-white dark:hover:bg-neutral-900 border border-transparent hover:border-neutral-200 dark:hover:border-neutral-800'
      }`}
    >
      {n}
    </button>
  )
}
