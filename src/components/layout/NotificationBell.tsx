import clsx from 'clsx'
import { Bell, BellOff } from 'lucide-react'
import { useNotifications } from '../../context/NotificationsContext'
import { useHumanReview } from '../../context/HumanReviewContext'
import { useT } from '../../context/LocaleContext'
import { NotificationDropdown } from './NotificationDropdown'

interface NotificationBellProps {
  open: boolean
  onOpen: () => void
  onClose: () => void
}

export function NotificationBell({ open, onOpen, onClose }: NotificationBellProps) {
  const t = useT()
  const nn = t.nav.notifications
  const { unreadCount, soundEnabled } = useNotifications()
  const { pending: pendingReviews } = useHumanReview()
  const badge = unreadCount > 9 ? '9+' : unreadCount > 0 ? String(unreadCount) : null

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? onClose() : onOpen())}
        title={nn.title}
        aria-label={nn.title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(
          'relative rounded-lg p-1.5 transition-colors sm:p-2',
          open
            ? 'text-green-400 bg-teal-50 dark:text-green-400 dark:bg-teal-950/50'
            : soundEnabled
              ? 'text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              : 'text-neutral-900 hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-neutral-800',
        )}
      >
        {soundEnabled ? (
          <Bell className="h-5 w-5" />
        ) : (
          <BellOff className="h-5 w-5" />
        )}
        {pendingReviews.length > 0 ? (
          <span
            className="absolute -start-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-400"
            title={nn.reviewPending}
            aria-label={nn.reviewPending}
          />
        ) : null}
        {badge ? (
          <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-green-400 px-1 text-[10px] font-bold leading-none text-neutral-950">
            {badge}
          </span>
        ) : null}
      </button>
      <NotificationDropdown open={open} onClose={onClose} />
    </div>
  )
}
