import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '../ui/Button'

const TITLE_FALLBACK = 'Account connected to Telegram channels'
const BODY_FALLBACK =
  'This account is currently connected to Telegram channels you own. For it to be a slave account, you need to disconnect the channels. This is being done to prevent duplicate trades.'
const CHANNELS_LABEL_FALLBACK = 'Connected channels'
const USE_DIFFERENT_FALLBACK = 'Use a different account'
const DISCONNECT_FALLBACK = 'Disconnect channels'
const DISCONNECTING_FALLBACK = 'Disconnecting channels…'

export interface SlaveChannelConflictChannel {
  id: string
  name: string
}

type SlaveChannelConflictModalProps = {
  brokerLabel: string
  channels: SlaveChannelConflictChannel[]
  closeLabel: string
  busy: boolean
  error: string | null
  labels?: {
    title?: string
    body?: string
    channelsLabel?: string
    useDifferent?: string
    disconnect?: string
    disconnecting?: string
  }
  onDisconnectChannels: () => void
  /** When provided, shows the "Use a different account" button. */
  onUseDifferentAccount?: () => void
  onClose: () => void
}

/**
 * Blocks making an account a mirror slave while it is still connected to
 * owned Telegram channels, so the same signal cannot trade twice on one broker.
 */
export function SlaveChannelConflictModal({
  brokerLabel,
  channels,
  closeLabel,
  busy,
  error,
  labels,
  onDisconnectChannels,
  onUseDifferentAccount,
  onClose,
}: SlaveChannelConflictModalProps) {
  const title = labels?.title ?? TITLE_FALLBACK
  const body = labels?.body ?? BODY_FALLBACK
  const channelsLabel = labels?.channelsLabel ?? CHANNELS_LABEL_FALLBACK
  const useDifferentLabel = labels?.useDifferent ?? USE_DIFFERENT_FALLBACK
  const disconnectLabel = labels?.disconnect ?? DISCONNECT_FALLBACK
  const disconnectingLabel = labels?.disconnecting ?? DISCONNECTING_FALLBACK

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-110 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="slave-channel-conflict-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={closeLabel}
        onClick={busy ? undefined : onClose}
      />
      <div className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-start gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4.5 w-4.5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="slave-channel-conflict-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
              {title}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-neutral-900 dark:text-neutral-50">{body}</p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-neutral-900 hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-neutral-800"
            aria-label={closeLabel}
            disabled={busy}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <div className="text-xs font-medium text-neutral-900 dark:text-neutral-50">{brokerLabel}</div>
          <div className="mt-2 rounded-xl border border-neutral-200/65 bg-neutral-50/80 px-3.5 py-2.5 dark:border-neutral-800/55 dark:bg-neutral-800/40">
            <div className="text-xs font-medium text-neutral-900 dark:text-neutral-50">{channelsLabel}</div>
            <ul className="mt-1.5 space-y-1">
              {channels.map(channel => (
                <li key={channel.id} className="text-xs text-neutral-900 dark:text-neutral-50">
                  {channel.name}
                </li>
              ))}
            </ul>
          </div>
          {error ? (
            <p className="mt-3 text-xs leading-relaxed text-error-600 dark:text-error-300">{error}</p>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:flex-row sm:justify-end">
          {onUseDifferentAccount ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onUseDifferentAccount}
              className="sm:min-w-40"
            >
              {useDifferentLabel}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="danger"
            size="sm"
            loading={busy}
            onClick={onDisconnectChannels}
            className="sm:min-w-40"
          >
            {busy ? disconnectingLabel : disconnectLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
