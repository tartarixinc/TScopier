import clsx from 'clsx'
import { Loader2, RefreshCw } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import type { DisplayableTradeActivity } from '../../lib/tradeActivities'

type StatusVariant = 'success' | 'warning' | 'error'

function statusVariant(status: DisplayableTradeActivity['status']): StatusVariant {
  if (status === 'successful') return 'success'
  if (status === 'skipped') return 'warning'
  return 'error'
}

function statusLabel(
  status: DisplayableTradeActivity['status'],
  labels: { successful: string; skipped: string; failed: string },
): string {
  if (status === 'successful') return labels.successful
  if (status === 'skipped') return labels.skipped
  return labels.failed
}

export function TradeActivityCard({
  activity,
  variant = 'compact',
  isRetrying = false,
  onRetry,
}: {
  activity: DisplayableTradeActivity
  variant?: 'compact' | 'full'
  isRetrying?: boolean
  onRetry?: () => void
}) {
  const t = useT()
  const timeLabel = new Date(activity.row.created_at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  if (variant === 'compact') {
    return (
      <div className="px-5 py-3">
        <p className="text-sm text-neutral-800 dark:text-neutral-100">{activity.message}</p>
        <p className="text-[11px] text-neutral-400 mt-1">{timeLabel}</p>
      </div>
    )
  }

  const statusLabels = {
    successful: t.management.statusSuccessful,
    skipped: t.management.statusSkipped,
    failed: t.management.statusFailed,
  }

  return (
    <article className="px-4 sm:px-5 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{activity.kind}</p>
            <Badge variant={statusVariant(activity.status)} size="sm">
              {statusLabel(activity.status, statusLabels)}
            </Badge>
          </div>
          <p className="text-sm text-neutral-700 dark:text-neutral-200 leading-relaxed">{activity.message}</p>
        </div>
        {activity.retryEligible && onRetry ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={isRetrying}
            onClick={onRetry}
          >
            {isRetrying ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {t.management.retry}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
        <span>{timeLabel}</span>
        {activity.symbol ? (
          <>
            <span aria-hidden className="text-neutral-300 dark:text-neutral-600">·</span>
            <span className="font-medium text-neutral-500 dark:text-neutral-400">{activity.symbol}</span>
          </>
        ) : null}
        {activity.channelName ? (
          <>
            <span aria-hidden className="text-neutral-300 dark:text-neutral-600">·</span>
            <span className="truncate max-w-[14rem]" title={activity.channelName}>{activity.channelName}</span>
          </>
        ) : null}
      </div>
    </article>
  )
}

export function TradeActivityCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={clsx('px-4 sm:px-5 py-4 space-y-3', className)}>
      <div className="flex justify-between gap-3">
        <div className="h-5 w-32 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
        <div className="h-8 w-16 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
      </div>
      <div className="h-4 w-full bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
      <div className="h-3 w-1/3 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
    </div>
  )
}
