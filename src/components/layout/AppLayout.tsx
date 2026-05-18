import { useEffect, useMemo, useRef, useState } from 'react'
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
  ChartBar as BarChart2,
  CircleHelp,
  ChevronDown,
  ChartNoAxesColumn,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { TscopierLogo } from '../ui/TscopierLogo'
import { AppSearchDesktop, AppSearchMobileTrigger, AppSearchProvider } from './AppSearch'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { ThemeToggle } from '../ui/ThemeToggle'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { HelpMenuDropdown } from './HelpMenuDropdown'
import { UserMenuDropdown } from './UserMenuDropdown'
import { useUserProfile } from '../../context/UserProfileContext'

export function AppLayout() {
  const t = useT()
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null)
  const helpMenuRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const helpMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { profile } = useUserProfile()

  const openHelpMenu = () => {
    if (helpMenuCloseTimerRef.current) {
      clearTimeout(helpMenuCloseTimerRef.current)
      helpMenuCloseTimerRef.current = null
    }
    setHelpMenuOpen(true)
  }

  const scheduleCloseHelpMenu = () => {
    if (helpMenuCloseTimerRef.current) clearTimeout(helpMenuCloseTimerRef.current)
    helpMenuCloseTimerRef.current = setTimeout(() => {
      setHelpMenuOpen(false)
      helpMenuCloseTimerRef.current = null
    }, 150)
  }

  const openUserMenu = () => {
    if (userMenuCloseTimerRef.current) {
      clearTimeout(userMenuCloseTimerRef.current)
      userMenuCloseTimerRef.current = null
    }
    setUserMenuOpen(true)
  }

  const scheduleCloseUserMenu = () => {
    if (userMenuCloseTimerRef.current) clearTimeout(userMenuCloseTimerRef.current)
    userMenuCloseTimerRef.current = setTimeout(() => {
      setUserMenuOpen(false)
      userMenuCloseTimerRef.current = null
    }, 150)
  }

  useEffect(() => {
    return () => {
      if (helpMenuCloseTimerRef.current) clearTimeout(helpMenuCloseTimerRef.current)
      if (userMenuCloseTimerRef.current) clearTimeout(userMenuCloseTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!helpMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!helpMenuRef.current?.contains(e.target as Node)) {
        setHelpMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [helpMenuOpen])

  useEffect(() => {
    if (!userMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!userMenuRef.current?.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [userMenuOpen])

  const navSections = useMemo(
    () => [
      {
        label: t.nav.sections.general,
        items: [
          { to: '/dashboard', icon: LayoutDashboard, label: t.nav.items.dashboard },
          { to: '/account-configuration', icon: Settings, label: t.nav.items.configuration },
          { to: '/account-trades', icon: History, label: t.nav.items.trades },
        ],
      },
      {
        label: t.nav.sections.signals,
        items: [
          { to: '/channels', icon: Send, label: t.nav.items.channels },
          { to: '/backtest', icon: LayoutTemplate, label: t.nav.items.backtest },
          { to: '/copier-logs', icon: ScrollText, label: t.nav.items.copierLogs },
          { to: '/signal-history', icon: ChartNoAxesColumn, label: t.nav.items.signalHistory },
          { to: '/performance', icon: BarChart2, label: t.nav.items.performance },
        ],
      },
      {
        label: t.nav.sections.tradingTools,
        items: [
          { to: '/market-news', icon: Newspaper, label: t.nav.items.marketNews },
          { to: '/economic-calendar', icon: Calendar, label: t.nav.items.economicCalendar },
        ],
      },
    ],
    [t],
  )

  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  useEffect(() => {
    document.documentElement.classList.add('app-viewport-lock')
    return () => document.documentElement.classList.remove('app-viewport-lock')
  }, [])

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

  const initials = (() => {
    const first = profile.first_name?.trim()
    const last = profile.last_name?.trim()
    if (first && last) return `${first[0]}${last[0]}`.toUpperCase()
    if (first) return first.slice(0, 2).toUpperCase()
    return user?.email?.slice(0, 2).toUpperCase() ?? 'U'
  })()
  const displayName =
    [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() ||
    profile.display_name?.trim() ||
    user?.email?.split('@')[0] ||
    'User'

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
            {section.items.map(({ to, icon: Icon, label }) => (
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
            ))}
          </div>
        </div>
      ))}
    </>
  )

  return (
    <div className="flex h-[100dvh] min-h-0 w-full overflow-hidden overscroll-none bg-neutral-50 dark:bg-neutral-950">
      {mobileNavOpen && (
        <button
          type="button"
          aria-label={t.nav.closeMenu}
          className="fixed inset-0 z-40 bg-neutral-900/40 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

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
          <TscopierLogo className="h-6 w-auto lg:hidden" />
          <div
            className={clsx(
              'hidden lg:block transition-all duration-200',
              !sidebarExpanded && 'mx-auto',
            )}
          >
            <TscopierLogo
              collapsed={!sidebarExpanded}
              className={sidebarExpanded ? 'h-6 w-auto' : undefined}
            />
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 lg:hidden"
            aria-label={t.nav.closeMenu}
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

      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-none">
        <AppSearchProvider headerEl={headerEl}>
        <header
          ref={setHeaderEl}
          className={clsx(
            'z-30 flex shrink-0 touch-none items-center gap-2 border-b border-neutral-100 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-900 sm:gap-4 sm:px-6',
            'fixed inset-x-0 top-0 h-[calc(3.5rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)] sm:h-[calc(4rem+env(safe-area-inset-top,0px))]',
            'lg:static lg:z-20 lg:h-16 lg:min-h-0 lg:pt-0 lg:touch-auto',
          )}
        >
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="p-2 rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 transition-colors lg:hidden"
            aria-label={t.nav.openMenu}
          >
            <Menu className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => setIsSidebarCollapsed(prev => !prev)}
            title={isSidebarCollapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
            className="hidden lg:block p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            {isSidebarCollapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
          </button>

          <AppSearchDesktop className="flex-1 max-w-md min-w-0" />

          <div className="flex-1 min-w-0 lg:hidden" />

          <div className="relative z-40 flex shrink-0 items-center gap-1 sm:gap-2 lg:ml-auto">
            <AppSearchMobileTrigger />
            <LanguageSwitcher />
            <ThemeToggle />
            <div
              ref={helpMenuRef}
              className="relative"
              onMouseEnter={openHelpMenu}
              onMouseLeave={scheduleCloseHelpMenu}
            >
              <button
                type="button"
                onClick={() => {
                  if (!window.matchMedia('(hover: hover)').matches) {
                    setHelpMenuOpen(open => !open)
                  }
                }}
                title={t.nav.help}
                aria-label={t.nav.help}
                aria-haspopup="menu"
                aria-expanded={helpMenuOpen}
                className={clsx(
                  'p-2 rounded-lg transition-colors',
                  helpMenuOpen
                    ? 'text-teal-600 bg-teal-50 dark:text-teal-400 dark:bg-teal-950/50'
                    : 'text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                )}
              >
                <CircleHelp className="w-5 h-5" />
              </button>
              <HelpMenuDropdown open={helpMenuOpen} onClose={() => setHelpMenuOpen(false)} />
            </div>

            <div
              ref={userMenuRef}
              className="relative"
              onMouseEnter={openUserMenu}
              onMouseLeave={scheduleCloseUserMenu}
            >
              <button
                type="button"
                onClick={() => {
                  if (!window.matchMedia('(hover: hover)').matches) {
                    setUserMenuOpen(open => !open)
                  }
                }}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                aria-label={t.nav.userMenu.menuLabel}
                className={clsx(
                  'flex items-center gap-2 rounded-lg pl-1 pr-2 min-h-[44px] transition-colors',
                  userMenuOpen
                    ? 'bg-neutral-100 dark:bg-neutral-800'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
                )}
              >
              <div className="w-8 h-8 rounded-full bg-teal-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                {initials}
              </div>
              <div className="hidden md:block text-left">
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 leading-tight truncate max-w-[8rem]">
                  {displayName}
                </p>
                <p className="text-xs text-neutral-400 leading-tight">{t.nav.planFree}</p>
              </div>
                <ChevronDown
                  className={clsx(
                    'hidden md:block w-3.5 h-3.5 text-neutral-400 shrink-0 transition-transform',
                    userMenuOpen && 'rotate-180',
                  )}
                />
              </button>
              <UserMenuDropdown
                open={userMenuOpen}
                onClose={() => setUserMenuOpen(false)}
                onSignOut={handleSignOut}
              />
            </div>
          </div>
        </header>
        </AppSearchProvider>

        <main
          className={clsx(
            'min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain bg-neutral-50 dark:bg-neutral-950',
            'pt-[calc(3.5rem+env(safe-area-inset-top,0px))] sm:pt-[calc(4rem+env(safe-area-inset-top,0px))]',
            'lg:pt-0',
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
