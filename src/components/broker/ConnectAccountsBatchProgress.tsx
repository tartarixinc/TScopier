import clsx from 'clsx'
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'
import type { AccountConfigBulkConnectTranslations } from '../../i18n/locales/types'
import type { BulkConnectRowProgress, BulkConnectRowStatus } from '../../lib/bulkConnectBrokers'

function statusLabel(status: BulkConnectRowStatus, copy: AccountConfigBulkConnectTranslations): string {
  switch (status) {
    case 'queued': return copy.statusQueued
    case 'linking': return copy.statusLinking
    case 'linked': return copy.statusLinked
    case 'failed': return copy.statusFailed
    case 'skipped_duplicate': return copy.statusSkippedDuplicate
    case 'skipped_limit': return copy.statusSkippedLimit
    case 'skipped_invalid': return copy.statusSkippedInvalid
    default: return status
  }
}

function StatusIcon({ status }: { status: BulkConnectRowStatus }) {
  if (status === 'linking') {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-teal-600 dark:text-teal-400" />
  }
  if (status === 'linked') {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" />
  }
  if (status === 'failed') {
    return <XCircle className="h-4 w-4 shrink-0 text-error-500" />
  }
  return <Circle className="h-4 w-4 shrink-0 text-neutral-300 dark:text-neutral-600" />
}

type ConnectAccountsBatchProgressProps = {
  title: string
  rows: BulkConnectRowProgress[]
  copy: AccountConfigBulkConnectTranslations
  className?: string
}

export function ConnectAccountsBatchProgress({
  title,
  rows,
  copy,
  className,
}: ConnectAccountsBatchProgressProps) {
  return (
    <div
      className={clsx(
        'absolute inset-0 flex flex-col bg-white/95 px-6 py-8 dark:bg-neutral-900/95 sm:px-8',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{title}</p>
      <ul className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto">
        {rows.map(entry => {
          const login = entry.row.account_number.trim() || '—'
          const server = entry.row.broker_server.trim()
          return (
            <li
              key={entry.index}
              className="flex items-start gap-3 rounded-xl border border-neutral-100 px-3 py-2.5 dark:border-neutral-800"
            >
              <StatusIcon status={entry.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                  {entry.row.label.trim() || login}
                </p>
                <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                  {login}{server ? ` · ${server}` : ''}
                </p>
                {entry.error ? (
                  <p className="mt-1 text-xs text-error-600 dark:text-error-400">{entry.error}</p>
                ) : null}
              </div>
              <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                {statusLabel(entry.status, copy)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
