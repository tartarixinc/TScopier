import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import {
  TradeActivityCard,
  TradeActivityCardSkeleton,
} from '../../components/dashboard/TradeActivityCard'
import { useTradeActivitiesRealtime } from '../../hooks/useTradeActivitiesRealtime'
import { retryActivityApi } from '../../lib/retryActivityApi'
import { formatRetryFailureReason } from '../../lib/retryActivityDisplay'
import {
  buildChannelDisplayNames,
  buildDisplayableTradeActivities,
  filterTradeActivitiesByTab,
  TRADE_ACTIVITY_FETCH_LIMIT,
  TRADE_EXECUTION_LOG_SELECT,
  type TradeActivityFilter,
  type TradeActivityLogRow,
} from '../../lib/tradeActivities'

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number]

type ChannelNameRow = { id: string; display_name: string; channel_username?: string | null }

export function ManagementPage() {
  const { user } = useAuth()
  const t = useT()
  const [filter, setFilter] = useState<TradeActivityFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSizeOption>(25)
  const [loading, setLoading] = useState(true)
  const [rawLogs, setRawLogs] = useState<TradeActivityLogRow[]>([])
  const [channelDisplayNames, setChannelDisplayNames] = useState<Record<string, string>>({})
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [retryingLogIds, setRetryingLogIds] = useState<Set<string>>(() => new Set())
  const [retryAllBusy, setRetryAllBusy] = useState(false)

  const showToast = useCallback((message: string) => {
    setToastMessage(message)
    window.setTimeout(() => setToastMessage(null), 4500)
  }, [])

  const loadActivities = useCallback(async (opts?: { background?: boolean }) => {
    if (!user) return
    const background = opts?.background === true
    if (!background) setLoading(true)
    const [channelsRes, logsRes] = await Promise.all([
      supabase
        .from('telegram_channels')
        .select('id,display_name,channel_username')
        .eq('user_id', user.id),
      supabase
        .from('trade_execution_logs')
        .select(TRADE_EXECUTION_LOG_SELECT)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(TRADE_ACTIVITY_FETCH_LIMIT),
    ])

    setChannelDisplayNames(buildChannelDisplayNames((channelsRes.data ?? []) as ChannelNameRow[]))
    setRawLogs((logsRes.data ?? []) as TradeActivityLogRow[])
    if (!background) setLoading(false)
  }, [user])

  useEffect(() => {
    void loadActivities()
  }, [loadActivities])

  useTradeActivitiesRealtime(user?.id, () => { void loadActivities({ background: true }) })

  useEffect(() => {
    setPage(1)
  }, [filter, pageSize])

  const allActivities = useMemo(
    () => buildDisplayableTradeActivities(rawLogs, t.channelWorker, t.management, channelDisplayNames),
    [rawLogs, t.channelWorker, t.management, channelDisplayNames],
  )

  const filteredActivities = useMemo(
    () => filterTradeActivitiesByTab(allActivities, filter),
    [allActivities, filter],
  )

  const totalCount = filteredActivities.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const pageActivities = useMemo(() => {
    const from = (page - 1) * pageSize
    return filteredActivities.slice(from, from + pageSize)
  }, [filteredActivities, page, pageSize])

  const retryEligibleOnPage = useMemo(
    () => pageActivities.filter(a => a.retryEligible),
    [pageActivities],
  )

  const retrySingleActivity = useCallback(async (logId: string) => {
    setRetryingLogIds(prev => new Set(prev).add(logId))
    try {
      const result = await retryActivityApi.retry({ log_id: logId })
      const item = result.results.find(r => r.log_id === logId)
      if (!result.ok || !item?.ok) {
        showToast(formatRetryFailureReason(item?.reason ?? item?.error, t.management))
        return
      }
      showToast(t.management.retrySuccess)
      await loadActivities()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.management.retryFailedGeneric)
    } finally {
      setRetryingLogIds(prev => {
        const next = new Set(prev)
        next.delete(logId)
        return next
      })
    }
  }, [loadActivities, showToast, t.management])

  const retryAllOnPage = useCallback(async () => {
    const ids = retryEligibleOnPage.map(a => a.row.id)
    if (!ids.length) return
    setRetryAllBusy(true)
    try {
      const result = await retryActivityApi.retry({ log_ids: ids })
      if (result.retried > 0) {
        showToast(interpolate(t.management.retryAllSuccess, { count: String(result.retried) }))
        await loadActivities()
      }
      if (result.failed > 0) {
        const firstFailed = result.results.find(r => !r.ok)
        showToast(formatRetryFailureReason(firstFailed?.reason ?? firstFailed?.error, t.management))
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.management.retryFailedGeneric)
    } finally {
      setRetryAllBusy(false)
    }
  }, [loadActivities, retryEligibleOnPage, showToast, t.management])

  const filters: { value: TradeActivityFilter; label: string }[] = useMemo(
    () => [
      { value: 'all', label: t.management.filterAll },
      { value: 'successful', label: t.management.filterSuccessful },
      { value: 'skipped', label: t.management.filterSkipped },
      { value: 'failed', label: t.management.filterFailed },
    ],
    [t.management],
  )

  const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = Math.min(page * pageSize, totalCount)

  const emptyTitle = filter === 'failed' ? t.management.emptyFailedTitle : t.management.emptyTitle

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      <PageHeader
        title={t.management.title}
        subtitle={t.management.subtitle}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {filter === 'failed' && retryEligibleOnPage.length > 0 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={retryAllBusy}
                onClick={() => { void retryAllOnPage() }}
              >
                {retryAllBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {t.management.retryAll}
              </Button>
            ) : null}
            <div className="-mx-4 w-full overflow-x-auto px-4 sm:mx-0 sm:w-auto sm:px-0">
              <div className="inline-flex bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-0.5 gap-0.5">
                {filters.map(f => (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setFilter(f.value)}
                    className={clsx(
                      'shrink-0 px-3 py-2 text-xs rounded-md font-medium transition-colors whitespace-nowrap',
                      filter === f.value
                        ? 'bg-teal-600 text-white'
                        : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      />

      <Card padding="none" className="overflow-hidden">
        {loading ? (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {[...Array(4)].map((_, i) => (
              <TradeActivityCardSkeleton key={i} />
            ))}
          </div>
        ) : pageActivities.length === 0 ? (
          <div className="px-4 sm:px-6 py-12 sm:py-20 text-center">
            <div className="w-16 h-16 bg-neutral-100 dark:bg-neutral-800 rounded-2xl mx-auto mb-3 flex items-center justify-center">
              <RefreshCw className="w-8 h-8 text-neutral-300" />
            </div>
            <p className="text-sm font-medium text-neutral-400">{emptyTitle}</p>
            <p className="text-xs text-neutral-300 mt-1">{t.management.emptySubtitle}</p>
          </div>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {pageActivities.map(activity => (
              <TradeActivityCard
                key={activity.row.id}
                activity={activity}
                variant="full"
                isRetrying={retryingLogIds.has(activity.row.id)}
                onRetry={activity.retryEligible
                  ? () => { void retrySingleActivity(activity.row.id) }
                  : undefined}
              />
            ))}
          </div>
        )}

        {!loading && totalCount > 0 ? (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 py-3 border-t border-neutral-100 dark:border-neutral-800">
            <p className="text-xs text-neutral-400">
              {rangeStart}–{rangeEnd} of {totalCount}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-neutral-500">
                <span>Rows</span>
                <select
                  value={pageSize}
                  onChange={e => setPageSize(Number(e.target.value) as PageSizeOption)}
                  className="rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs"
                >
                  {PAGE_SIZE_OPTIONS.map(size => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  className="p-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs text-neutral-500 px-2 tabular-nums">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  className="p-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 disabled:opacity-40"
                  aria-label="Next page"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </Card>

      {toastMessage ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-md px-4 py-3 rounded-xl bg-neutral-900 text-white text-sm shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
        >
          {toastMessage}
        </div>
      ) : null}
    </PageShell>
  )
}
