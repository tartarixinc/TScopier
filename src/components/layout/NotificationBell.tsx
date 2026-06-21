import clsx from 'clsx'
import { Bell, BellOff } from 'lucide-react'
import { useNotifications } from '../../context/NotificationsContext'
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
          'relative rounded-lg p-2 transition-colors',
          open
            ? 'text-teal-600 bg-teal-50 dark:text-teal-400 dark:bg-teal-950/50'
            : soundEnabled
              ? 'text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              : 'text-neutral-300 hover:bg-neutral-100 dark:text-neutral-600 dark:hover:bg-neutral-800',
        )}
      >
        {soundEnabled ? (
          <Bell className="h-5 w-5" />
        ) : (
          <BellOff className="h-5 w-5" />
        )}
        {badge ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-teal-600 px-1 text-[10px] font-bold leading-none text-white">
            {badge}
          </span>
        ) : null}
      </button>
      <NotificationDropdown open={open} onClose={onClose} />
    </div>
  )
}
