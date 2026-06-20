import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Settings,
  CreditCard,
  Share2,
  LogOut,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { useSubscription } from '../../context/SubscriptionContext'

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
      kind: 'action'
      label: string
      icon: LucideIcon
      destructive?: boolean
    }

function userInitials(
  profile: { first_name?: string; last_name?: string },
  email?: string | null,
): string {
  const first = profile.first_name?.trim()
  const last = profile.last_name?.trim()
  if (first && last) return `${first[0]}${last[0]}`.toUpperCase()
  if (first) return first.slice(0, 2).toUpperCase()
  return email?.slice(0, 2).toUpperCase() ?? 'U'
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
    { id: 'profile', kind: 'link', label: um.profileSettings, icon: Settings, path: '/settings' },
    { id: 'billing', kind: 'link', label: um.subscriptionBilling, icon: CreditCard, path: '/billing' },
    { id: 'affiliate', kind: 'link', label: um.affiliateProgram, icon: Share2, path: '/affiliate-program' },
    { id: 'signout', kind: 'action', label: um.signOut, icon: LogOut, destructive: true },
  ]

  const handleSelect = (item: MenuItem) => {
    if (item.kind === 'link') {
      navigate(item.path)
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

  const initials = userInitials(profile, user?.email)

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={um.menuLabel}
      className={clsx(
        'absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-neutral-200 bg-white py-1 shadow-lg',
        'before:absolute before:-top-1 before:right-0 before:left-0 before:h-1 before:content-[""]',
        'dark:border-neutral-700 dark:bg-neutral-900',
      )}
    >
      <div className="border-b border-neutral-100 px-3 py-3 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-600 text-sm font-semibold text-white">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{headerName}</p>
            <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{user?.email}</p>
            <p className="mt-0.5 text-xs font-medium text-teal-600 dark:text-teal-400">{planName || t.nav.planFree}</p>
          </div>
        </div>
      </div>

      <ul className="py-1">
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
                  'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm font-medium transition-colors',
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
                {item.kind === 'link' ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
