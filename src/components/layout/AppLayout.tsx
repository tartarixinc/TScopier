import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Settings,
  History,
  Send,
  LayoutTemplate,
  ScrollText,
  Newspaper,
  Calendar,
  TrendingUp,
  ChartBar as BarChart2,
  LifeBuoy,
  Lightbulb,
  Handshake,
  Share2,
  CreditCard,
  Repeat,
  Briefcase,
  ChartPie as PieChart,
  Search,
  Bell,
  ChevronDown,
  LogOut,
  ChartNoAxesColumn,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { TscopierLogo } from '../ui/TscopierLogo'
import { useAuth } from '../../context/AuthContext'
import { ThemeToggle } from '../ui/ThemeToggle'

interface NavSection {
  label: string
  items: { to: string; icon: React.ElementType; label: string; disabled?: boolean }[]
}

const navSections: NavSection[] = [
  {
    label: 'GENERAL',
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/account-configuration', icon: Settings, label: 'Configuration' },
      { to: '/account-trades', icon: History, label: 'Trades' },
    ],
  },
  {
    label: 'SIGNALS',
    items: [
      { to: '/copier-engine', icon: Send, label: 'Channels' },
      { to: '/backtest', icon: LayoutTemplate, label: 'Backtest' },
      { to: '/copier-logs', icon: ScrollText, label: 'Copier Logs' },
      { to: '/signal-history', icon: ChartNoAxesColumn, label: 'History' },
    ],
  },
  {
    label: 'TRADING TOOLS',
    items: [
      { to: '/market-news', icon: Newspaper, label: 'Market News' },
      { to: '/economic-calendar', icon: Calendar, label: 'Economic Calendar' },
      { to: '/sentiments', icon: TrendingUp, label: 'Sentiments' },
    ],
  },
  {
    label: 'SIGNAL ANALYZER',
    items: [
      { to: '/performance', icon: BarChart2, label: 'Performance' },
      { to: '/portfolio', icon: Briefcase, label: 'Portfolio' },
      { to: '/analysis-hub', icon: PieChart, label: 'Analysis Hub' },
    ],
  },
  {
    label: 'FEEDBACK',
    items: [
      { to: '/contact-support', icon: LifeBuoy, label: 'Contact Support' },
      { to: '/feature-request', icon: Lightbulb, label: 'Feature Request' },
    ],
  },
  {
    label: 'GROWTH & MONETIZATION',
    items: [
      { to: '/partner-with-us', icon: Handshake, label: 'Partner with us' },
      { to: '/affiliate-program', icon: Share2, label: 'Affiliate program' },
    ],
  },
  {
    label: 'MEMBERSHIP',
    items: [
      { to: '/billing', icon: CreditCard, label: 'Billing' },
      { to: '/subscriptions', icon: Repeat, label: 'Subscriptions' },
    ],
  },
]

export function AppLayout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
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

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  const initials = user?.email?.slice(0, 2).toUpperCase() ?? 'U'
  const displayName = user?.email?.split('@')[0] ?? 'User'

  const sidebarExpanded = !isSidebarCollapsed

  const navLinkClass = (isCollapsed: boolean) =>
    ({ isActive }: { isActive: boolean }) =>
      clsx(
        'flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors min-h-[44px]',
        isCollapsed ? 'justify-center' : 'gap-3',
        isActive
          ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-400'
          : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
      )

  const renderNav = (opts: { collapsed: boolean; onNavigate?: () => void }) => (
    <>
      {navSections.map(section => (
        <div key={section.label}>
          <p
            className={clsx(
              'px-3 text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 tracking-widest mb-1.5',
              opts.collapsed && 'hidden',
            )}
          >
            {section.label}
          </p>
          <div className="space-y-0.5">
            {section.items.map(({ to, icon: Icon, label, disabled }) =>
              disabled ? (
                <div
                  key={to}
                  title={label}
                  className={clsx(
                    'flex items-center rounded-lg px-3 py-2.5 text-sm text-neutral-300 dark:text-neutral-600 cursor-not-allowed select-none min-h-[44px]',
                    opts.collapsed ? 'justify-center' : 'gap-3',
                  )}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span className={clsx(opts.collapsed && 'lg:hidden')}>{label}</span>
                </div>
              ) : (
                <NavLink
                  key={to}
                  to={to}
                  title={label}
                  onClick={opts.onNavigate}
                  className={navLinkClass(opts.collapsed)}
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        className={clsx(
                          'w-4 h-4 flex-shrink-0',
                          isActive ? 'text-teal-600 dark:text-teal-400' : '',
                        )}
                      />
                      <span className={clsx(opts.collapsed && 'lg:hidden')}>{label}</span>
                    </>
                  )}
                </NavLink>
              ),
            )}
          </div>
        </div>
      ))}
    </>
  )

  return (
    <div className="flex h-[100dvh] min-h-0 w-full overflow-hidden bg-neutral-50 dark:bg-neutral-950">
      {/* Mobile backdrop */}
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-40 bg-neutral-900/40 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Sidebar — drawer on mobile, docked on lg+ */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 flex h-full min-h-0 flex-col overflow-hidden border-r border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900 transition-transform duration-200 ease-out',
          'w-64 max-w-[85vw]',
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:sticky lg:top-0 lg:z-30 lg:max-w-none lg:translate-x-0',
          isSidebarCollapsed ? 'lg:w-20' : 'lg:w-64',
        )}
      >
        <div
          className={clsx(
            'flex h-16 shrink-0 items-center border-b border-neutral-100 dark:border-neutral-800',
            sidebarExpanded ? 'justify-between px-4' : 'justify-center px-2',
          )}
        >
          <TscopierLogo className="h-8 w-auto lg:hidden" />
          <div
            className={clsx(
              'hidden lg:block transition-all duration-200',
              !sidebarExpanded && 'mx-auto',
            )}
          >
            <TscopierLogo
              collapsed={!sidebarExpanded}
              className={sidebarExpanded ? 'h-8 w-auto' : undefined}
            />
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 lg:hidden"
            aria-label="Close menu"
            onClick={() => setMobileNavOpen(false)}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-3 py-4">
          {renderNav({
            collapsed: !sidebarExpanded,
            onNavigate: () => setMobileNavOpen(false),
          })}
        </nav>

        <div className="shrink-0 border-t border-neutral-100 dark:border-neutral-800 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            onClick={handleSignOut}
            title="Sign out"
            className={clsx(
              'flex w-full items-center rounded-lg px-3 py-2.5 text-sm text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 min-h-[44px]',
              sidebarExpanded ? 'gap-2.5' : 'justify-center',
            )}
          >
            <LogOut className="w-4 h-4" />
            {sidebarExpanded && 'Sign out'}
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-20 flex h-14 sm:h-16 shrink-0 items-center gap-2 sm:gap-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 sm:px-6 pt-[env(safe-area-inset-top)]">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="p-2 rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 transition-colors lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => setIsSidebarCollapsed(prev => !prev)}
            title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden lg:block p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            {isSidebarCollapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
          </button>

          <div className="hidden sm:block flex-1 max-w-sm min-w-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
              <input
                type="text"
                placeholder="Search"
                className="w-full pl-9 pr-4 py-2 text-sm bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder:text-neutral-400 dark:text-neutral-100"
              />
            </div>
          </div>

          <div className="flex-1 min-w-0" />

          <div className="flex items-center gap-1 sm:gap-3 shrink-0">
            <ThemeToggle />
            <button
              type="button"
              className="hidden sm:block p-2 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <Settings className="w-5 h-5" />
            </button>
            <button
              type="button"
              className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <Bell className="w-5 h-5" />
            </button>

            <button type="button" className="flex items-center gap-2 pl-1 min-h-[44px]">
              <div className="w-8 h-8 rounded-full bg-teal-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                {initials}
              </div>
              <div className="hidden md:block text-left">
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 leading-tight truncate max-w-[8rem]">
                  {displayName}
                </p>
                <p className="text-xs text-neutral-400 leading-tight">Free</p>
              </div>
              <ChevronDown className="hidden md:block w-3.5 h-3.5 text-neutral-400 shrink-0" />
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain bg-neutral-50 dark:bg-neutral-950">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
