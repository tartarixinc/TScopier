import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { Badge } from '../ui/Badge'
import type { MirrorCopyLogRow } from '../../lib/mirrorCopyLogs'
import type { SocialCopyLogRow } from '../../lib/socialCopyLogs'

type StatusVariant = 'success' | 'warning' | 'error' | 'neutral' | 'primary'

type AccountCopyLogRow = Pick<
  MirrorCopyLogRow,
  | 'createdAt'
  | 'action'
  | 'symbol'
  | 'channelName'
  | 'destinationAccount'
  | 'sourceTicket'
  | 'destinationTicket'
  | 'lot'
  | 'reason'
> | Pick<
  SocialCopyLogRow,
  | 'createdAt'
  | 'action'
  | 'symbol'
  | 'channelName'
  | 'destinationAccount'
  | 'sourceTicket'
  | 'destinationTicket'
  | 'lot'
  | 'reason'
>

/**
 * Detail view for one account-copy event (mirror or social).
 *
 * Separate from CopierLogDetailModal because these copies are not signals: no
 * Telegram message, no parsed levels, no signal execution timeline.
 */
export function MirrorLogDetailModal({
  row,
  status,
  onClose,
  variant = 'mirror',
}: {
  row: AccountCopyLogRow | null
  status: { variant: StatusVariant; label: string; className?: string }
  onClose: () => void
  variant?: 'mirror' | 'social'
}) {
  const t = useT()
  const copierLogs = t.copierLogs
  const panelRef = useRef<HTMLDivElement>(null)
  const isSocial = variant === 'social'

  useEffect(() => {
    if (!row) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [row, onClose])

  if (!row) return null

  const label = (value: string | undefined, fallback: string) => value || fallback
  const detailLabel = (key: keyof NonNullable<typeof copierLogs.detailModal>, fallback: string) =>
    label(copierLogs.detailModal?.[key], fallback)

  const time = new Date(row.createdAt).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  const title = isSocial
    ? label(copierLogs.socialDetailTitle, 'Social copy details')
    : label(copierLogs.mirrorDetailTitle, 'Mirror copy details')
  const source = isSocial
    ? label(copierLogs.socialSource, 'Social trading')
    : label(copierLogs.mirrorSource, 'Mirror copy')
  const occurred = isSocial
    ? label(copierLogs.socialOccurred, 'Occurred')
    : label(copierLogs.mirrorOccurred, 'Occurred')
  const providerLabel = isSocial
    ? label(copierLogs.socialProvider, 'Provider')
    : label(copierLogs.mirrorMasterAccount, 'Master account')
  const destinationLabel = isSocial
    ? label(copierLogs.socialDestinationAccount, 'Your account')
    : label(copierLogs.mirrorSlaveAccount, 'Slave account')
  const sourceTicketLabel = isSocial
    ? label(copierLogs.socialProviderTicket, 'Provider ticket')
    : label(copierLogs.mirrorMasterTicket, 'Master ticket')
  const copyTicketLabel = isSocial
    ? label(copierLogs.socialCopyTicket, 'Copy ticket')
    : label(copierLogs.mirrorCopyTicket, 'Copy ticket')
  const lotLabel = isSocial
    ? label(copierLogs.socialLot, 'Lot')
    : label(copierLogs.mirrorLot, 'Lot')

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mirror-log-detail-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={detailLabel('close', 'Close')}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200/65 dark:border-neutral-800/55 bg-white dark:bg-neutral-900 shadow-2xl outline-none"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <div className="min-w-0">
            <h2
              id="mirror-log-detail-title"
              className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 truncate"
            >
              {title}
            </h2>
            <p className="mt-0.5 text-xs text-neutral-900 dark:text-neutral-50 truncate">
              {source} · {row.symbol}
            </p>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            aria-label={detailLabel('close', 'Close')}
            onClick={onClose}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <section className="rounded-xl border border-neutral-200/65 dark:border-neutral-800/55 p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={status.variant} size="sm" className={status.className}>{status.label}</Badge>
              {row.action ? (
                <span className={clsx(
                  'text-xs font-semibold uppercase',
                  row.action === 'buy'
                    ? 'text-green-400'
                    : row.action === 'sell'
                      ? 'text-error-600'
                      : 'text-neutral-900 dark:text-neutral-50',
                )}>
                  {row.action}
                </span>
              ) : null}
            </div>

            <DetailRow label={detailLabel('status', 'Status')} value={status.label} />
            <DetailRow label={occurred} value={time} />
            <DetailRow label={providerLabel} value={row.channelName} />
            <DetailRow label={destinationLabel} value={row.destinationAccount ?? '—'} />
            <DetailRow label={sourceTicketLabel} value={row.sourceTicket ?? '—'} mono />
            <DetailRow label={copyTicketLabel} value={row.destinationTicket ?? '—'} mono />
            <DetailRow label={detailLabel('symbol', 'Symbol')} value={row.symbol} />
            {row.lot != null ? (
              <DetailRow label={lotLabel} value={String(row.lot)} />
            ) : null}
            {row.reason ? (
              <DetailRow label={detailLabel('reason', 'Reason')} value={row.reason} emphasize />
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}

function DetailRow({
  label,
  value,
  emphasize,
  mono,
}: {
  label: string
  value: string
  emphasize?: boolean
  mono?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3 sm:items-start">
      <span className="text-xs font-medium text-neutral-900 dark:text-neutral-50 shrink-0 sm:w-32">{label}</span>
      <span
        className={clsx(
          'text-sm break-words',
          mono && 'font-mono',
          emphasize
            ? 'font-medium text-neutral-900 dark:text-neutral-50'
            : 'text-neutral-600 dark:text-neutral-300',
        )}
      >
        {value}
      </span>
    </div>
  )
}
