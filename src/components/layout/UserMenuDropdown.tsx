import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LogOut,
  ChevronRight,
  Star,
  Send,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { UserAvatar } from './UserAvatar'
import { getAppRouteIcon } from '../../lib/appNavIcons'
import { DirectionalIcon } from '../ui/DirectionalIcon'

const TRUSTPILOT_REVIEW_URL = 'https://www.trustpilot.com/review/tscopier.ai'

export interface UserMenuDropdownProps {
  open: boolean
  onClose: () => void
  onSignOut: () => void | Promise<void>
}

type MenuItem =
  | {
      id: string
      kind: 'link'
      label: string
      icon: LucideIcon
      path: string
    }
  | {
      id: string
      kind: 'external'
      label: string
      icon: LucideIcon
      href: string
    }
  | {
      id: string
      kind: 'action'
      label: string
      icon: LucideIcon
      destructive?: boolean
    }

export function UserMenuDropdown({ open, onClose, onSignOut }: UserMenuDropdownProps) {
  const t = useT()
  const um = t.nav.userMenu
  const navigate = useNavigate()
  const { user } = useAuth()
  const { profile } = useUserProfile()
  const { planName } = useSubscription()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const items: MenuItem[] = [
    { id: 'profile', kind: 'link', label: um.profileSettings, icon: getAppRouteIcon('/settings'), path: '/settings' },
    { id: 'billing', kind: 'link', label: um.subscriptionBilling, icon: getAppRouteIcon('/billing'), path: '/billing' },
    { id: 'affiliate', kind: 'link', label: um.affiliateProgram, icon: getAppRouteIcon('/affiliate-program'), path: '/affiliate-program' },
    { id: 'rate-us', kind: 'external', label: um.rateUs, icon: Star, href: TRUSTPILOT_REVIEW_URL },
    { id: 'join-telegram', kind: 'external', label: 'Join Telegram', icon: Send, href: 'https://t.me/tscopierai' },
    { id: 'signout', kind: 'action', label: um.signOut, icon: LogOut, destructive: true },
  ]

  const handleSelect = (item: MenuItem) => {
    if (item.kind === 'link') {
      navigate(item.path)
      onClose()
      return
    }
    if (item.kind === 'external') {
      window.open(item.href, '_blank', 'noopener,noreferrer')
      onClose()
      return
    }
    void onSignOut()
    onClose()
  }

  const headerName =
    [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() ||
    profile.display_name?.trim() ||
    user?.email?.split('@')[0] ||
    'User'

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={um.menuLabel}
      className={clsx(
        'absolute end-0 top-full z-50 mt-1 flex w-[min(16rem,calc(100vw-1rem))] max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-4.5rem)] flex-col overflow-hidden overscroll-contain rounded-xl border border-neutral-200 bg-white py-1 shadow-lg sm:max-h-[min(32rem,calc(100dvh-5rem))]',
        'before:absolute before:-top-1 before:inset-x-0 before:h-1 before:content-[""]',
        'dark:border-neutral-700 dark:bg-neutral-900',
      )}
    >
      <div className="shrink-0 border-b border-neutral-100 px-3 py-3 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <UserAvatar user={user} profile={profile} email={user?.email} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{headerName}</p>
            <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{user?.email}</p>
            <p className="mt-0.5 text-xs font-medium text-teal-600 dark:text-teal-400">{planName || t.nav.planFree}</p>
          </div>
        </div>
      </div>

      <ul className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
        {items.map(item => {
          const Icon = item.icon
          const isDestructive = item.kind === 'action' && item.destructive
          return (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => handleSelect(item)}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-2.5 text-start text-sm font-medium transition-colors',
                  isDestructive
                    ? 'text-error-600 hover:bg-error-50 dark:text-error-400 dark:hover:bg-error-950/40'
                    : 'text-neutral-800 hover:bg-neutral-50 dark:text-neutral-100 dark:hover:bg-neutral-800/80',
                )}
              >
                <span
                  className={clsx(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    isDestructive
                      ? 'bg-error-50 text-error-600 dark:bg-error-950/40 dark:text-error-400'
                      : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">{item.label}</span>
                {item.kind === 'link' || item.kind === 'external' ? (
                  <DirectionalIcon icon={ChevronRight} className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
