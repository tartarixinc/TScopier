import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  History,
  Radio,
  ScrollText,
  HandCoins,
  LogOut,
  Menu,
  X,
  Shield,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Dashboard', end: true },
      { to: '/users', icon: Users, label: 'Users' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/trades', icon: History, label: 'Trades' },
      { to: '/channels-backtests', icon: Radio, label: 'Channels & Backtests' },
      { to: '/copier-logs', icon: ScrollText, label: 'Copier Logs' },
      { to: '/affiliate-payouts', icon: HandCoins, label: 'Affiliate Payouts' },
    ],
  },
]

export function AppShell() {
  const location = useLocation()
  const { user } = useAuth()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!mobileNavOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [mobileNavOpen])

  const initials = useMemo(() => {
    const email = user?.email ?? 'A'
    return email.slice(0, 2).toUpperCase()
  }, [user?.email])

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
      isActive
        ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-400'
        : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
    )

  return (
    <div className="flex h-[100dvh] min-h-0 w-full overflow-hidden bg-neutral-50 dark:bg-neutral-950">
      {mobileNavOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-40 bg-neutral-900/40 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 flex h-full w-64 max-w-[85vw] flex-col overflow-hidden border-r border-neutral-100 bg-white transition-transform duration-200 ease-out dark:border-neutral-800 dark:bg-neutral-900',
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:sticky lg:top-0 lg:z-30 lg:max-w-none lg:translate-x-0',
        )}
      >
        <div className="flex h-16 shrink-0 items-center gap-2 border-b border-neutral-100 px-4 dark:border-neutral-800">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600 text-white">
            <Shield className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">TScopier</p>
            <p className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">Backoffice</p>
          </div>
        </div>

        <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3 py-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label}>
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-widest text-neutral-400 dark:text-neutral-500">
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map(({ to, icon: Icon, label, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={navLinkClass}
                    onClick={() => setMobileNavOpen(false)}
                  >
                    {({ isActive }) => (
                      <>
                        <Icon className={clsx('h-4 w-4 shrink-0', isActive ? 'text-teal-600 dark:text-teal-400' : '')} />
                        <span>{label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-neutral-100 p-3 dark:border-neutral-800">
          <div className="mb-2 flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">Admin</p>
              <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{user?.email ?? '—'}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-neutral-100 bg-white/95 px-4 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/95 lg:hidden">
          <button
            type="button"
            aria-label="Open menu"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            onClick={() => setMobileNavOpen(true)}
          >
            {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <Link to="/" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
            TScopier Backoffice
          </Link>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
