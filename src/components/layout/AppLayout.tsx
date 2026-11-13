import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, Flame, PanelLeftClose, PanelLeftOpen, Menu, Sparkles, X, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { getAppRouteIcon } from '../../lib/appNavIcons'
import { TscopierLogo } from '../ui/TscopierLogo'
import { DirectionalIcon } from '../ui/DirectionalIcon'
import { AppSearchDesktop, AppSearchMobileTrigger, AppSearchProvider } from './AppSearch'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { getSubscribeCtaLabel } from '../../lib/subscriptionCta'
import { ThemeToggle } from '../ui/ThemeToggle'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { HelpSidebarNav } from './HelpSidebarNav'
import { NotificationBell } from './NotificationBell'
import { CopierPauseToggle } from './CopierPauseToggle'
import { UserMenuDropdown } from './UserMenuDropdown'
import { UserAvatar } from './UserAvatar'
import { DashboardKeepAlive } from './DashboardKeepAlive'
import { useUserProfile } from '../../context/UserProfileContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { useOpenTradeCount } from '../../hooks/useHasOpenTrades'
import { interpolate } from '../../i18n/interpolate'
import { useHasHighImpactNewsToday } from '../../hooks/useHasHighImpactNewsToday'
import { useNeedsWelcome } from '../../hooks/useNeedsWelcome'
import { CopierLogToasts } from '../dashboard/CopierLogToasts'
import { CopierProcessToasts } from '../dashboard/CopierProcessToasts'
import { SignalSourceLogo } from '../dashboard/SignalSourceLogo'
import { consumePostAuthRedirect } from '../../lib/postAuthRedirect'
import { buildFlags } from '../../lib/featureFlags'
import type { SignalSourceKind } from '../../lib/signalSourceMark'

const SIGNAL_SOURCE_NAV_KINDS: SignalSourceKind[] = [
  'telegram',
  'whatsapp',
  'discord',
  'tradingview',
]
import {
  APP_CANVAS,
  APP_MAIN_SHELL,
  APP_PILL,
  APP_RAIL,
  APP_RAIL_ACTIVE,
  APP_RAIL_HOVER,
  APP_SECTION_LABEL,
} from '../../lib/appSurface'

type NavItem = {
  to: string
  label: string
  showOpenTradesIndicator?: boolean
  showHighImpactNewsIndicator?: boolean
  showSignalSourceIcons?: boolean
}

type AppLayoutProps = {
  onAssistantTrigger?: () => void
}

export function AppLayout({ onAssistantTrigger }: AppLayoutProps) {
  const t = useT()
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const onDashboardRoute = location.pathname === '/dashboard'
    || location.pathname.startsWith('/dashboard/broker/')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const userMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { profile } = useUserProfile()
  const { planName, hasActiveSubscription, checkoutSyncPending, effectivePlan, openUpgrade, isPastDue, hasTrialExpired } =
    useSubscription()
  const subscribeCta = getSubscribeCtaLabel(t, {
    isPastDue,
    effectivePlan,
    hasTrialExpired,
  })
  const { deferAppBootstrap } = useNeedsWelcome()
  const [calendarCheckEnabled, setCalendarCheckEnabled] = useState(false)
  useEffect(() => {
    if (deferAppBootstrap) return
    const enable = () => setCalendarCheckEnabled(true)
    if (typeof requestIdleCallback !== 'undefined') {
      const idleId = requestIdleCallback(enable, { timeout: 5000 })
      return () => cancelIdleCallback(idleId)
    }
    const timer = window.setTimeout(enable, 3000)
    return () => window.clearTimeout(timer)
  }, [deferAppBootstrap])
  const openTradeCount = useOpenTradeCount(deferAppBootstrap ? undefined : user?.id)
  const hasHighImpactNewsToday = useHasHighImpactNewsToday(
    deferAppBootstrap ? false : calendarCheckEnabled,
  )

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
      if (userMenuCloseTimerRef.current) clearTimeout(userMenuCloseTimerRef.current)
    }
  }, [])

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
    (): Array<{ label: string; items: NavItem[] }> => [
      {
        label: t.nav.sections.general,
        items: [
          { to: '/dashboard', label: t.nav.items.dashboard },
          { to: '/brokers', label: t.nav.items.brokers },
          // Configurations menu hidden for now.
          // { to: '/configurations', label: t.nav.items.configuration },
          { to: '/account-trades', label: t.nav.items.trades, showOpenTradesIndicator: true },
          { to: '/manage-signals', label: t.nav.items.signalHistory },
          { to: '/activities', label: t.nav.items.management },
          { to: '/copier-logs', label: t.nav.items.copierLogs },
          { to: '/reported-trades', label: t.nav.items.reportedTrades },
        ],
      },
      {
        label: t.nav.sections.copy,
        items: [
          { to: '/mirror-trading', label: t.nav.items.mirrorTrading },
          ...(buildFlags.hideSocialTrading ? [] : [{ to: '/social-trading', label: t.nav.items.socialTrading }]),
          { to: '/channels', label: t.nav.items.channels, showSignalSourceIcons: true },
          { to: '/backtest', label: t.nav.items.backtest },
          { to: '/performance', label: t.nav.items.performance },
        ],
      },
      // Popular channels disabled for now.
      // {
      //   label: t.nav.sections.discover,
      //   items: [
      //     { to: '/popular-channels', label: t.nav.items.popularChannels },
      //   ],
      // },
      {
        label: t.nav.sections.tradingTools,
        items: [
          { to: '/market-news', label: t.nav.items.marketNews },
          { to: '/economic-calendar', label: t.nav.items.economicCalendar, showHighImpactNewsIndicator: true },
        ],
      },
      {
        label: t.nav.sections.membership,
        items: [
          { to: '/billing', label: t.nav.userMenu.subscriptionBilling },
          { to: '/affiliate-program', label: t.nav.userMenu.affiliateProgram },
        ],
      },
    ],
    [t],
  )

  useEffect(() => {
    queueMicrotask(() => {
      setMobileNavOpen(false)
      setNotificationsOpen(false)
    })
  }, [location.pathname])

  // Subscription reminder modal on dashboard handles the nudge. No forced redirect.

  // After Stripe success, paywall may have raced to /pricing before webhook sync. Send back.
  useEffect(() => {
    if (!checkoutSyncPending) return
    if (location.pathname !== '/pricing') return
    navigate(consumePostAuthRedirect() ?? '/dashboard', { replace: true })
  }, [checkoutSyncPending, location.pathname, navigate])

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

  const handleAssistantTrigger = () => {
    onAssistantTrigger?.()
  }

  const displayName =
    [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() ||
    profile.display_name?.trim() ||
    user?.email?.split('@')[0] ||
    'User'

  const sidebarExpanded = !isSidebarCollapsed

  const navLinkClass = (isCollapsed: boolean, disabled = false) =>
    ({ isActive }: { isActive: boolean }) =>
      clsx(
        'flex items-center rounded-full px-3 py-1.5 text-sm min-h-8 transition-[colors,gap,padding] duration-300 ease-out',
        isCollapsed ? 'justify-center gap-0' : 'gap-2.5',
        disabled
          ? clsx('cursor-pointer font-medium text-neutral-600 opacity-45 dark:text-neutral-400', APP_RAIL_HOVER)
          : isActive
            ? clsx(APP_RAIL_ACTIVE, 'font-semibold')
            : clsx('font-medium text-neutral-600 dark:text-neutral-300', APP_RAIL_HOVER),
      )

  const navLabelClass = (collapsed: boolean) =>
    clsx(
      'overflow-hidden whitespace-nowrap transition-[opacity,max-width,margin] duration-300 ease-out',
      collapsed ? 'max-w-0 opacity-0' : 'max-w-[11rem] opacity-100',
    )

  const renderNavItemContent = (
    opts: { collapsed: boolean },
    {
      icon: Icon,
      label,
      isActive,
      showOpenTradesIndicator,
      showHighImpactNewsIndicator,
      showSignalSourceIcons,
    }: {
      icon: LucideIcon
      label: string
      isActive: boolean
      showOpenTradesIndicator?: boolean
      showHighImpactNewsIndicator?: boolean
      showSignalSourceIcons?: boolean
    },
  ) => {
    const showOpenIndicator = Boolean(showOpenTradesIndicator && openTradeCount > 0)
    const showFireIndicator = Boolean(showHighImpactNewsIndicator && hasHighImpactNewsToday)
    const openTradesTag = interpolate(t.nav.openTradesCount, { count: openTradeCount })
    return (
      <>
        <span className="relative inline-flex shrink-0">
          <Icon
            className={clsx(
              'h-4 w-4',
              isActive ? 'text-neutral-950 dark:text-neutral-50' : '',
            )}
            strokeWidth={1.75}
          />
          {showOpenIndicator && opts.collapsed ? (
            <span className="absolute -inset-e-2.5 -top-1.5 min-w-4 rounded-full bg-green-400 px-1 text-center text-[9px] font-semibold leading-4 text-neutral-950 tabular-nums">
              {openTradeCount}
            </span>
          ) : null}
          {showFireIndicator && opts.collapsed && !showOpenIndicator ? (
            <Flame
              className="absolute -inset-e-1 -top-1 h-2.5 w-2.5 text-orange-500"
              aria-hidden
            />
          ) : null}
        </span>
        <span className={navLabelClass(opts.collapsed)}>{label}</span>
        {showSignalSourceIcons && !opts.collapsed ? (
          <span className="inline-flex shrink-0 items-center" aria-hidden>
            {SIGNAL_SOURCE_NAV_KINDS.map((kind, index) => (
              <SignalSourceLogo
                key={kind}
                kind={kind}
                className={clsx(
                  'relative h-4 w-4 shrink-0 ring-1 ring-white dark:ring-neutral-950',
                  index > 0 && '-ms-1.5',
                )}
              />
            ))}
          </span>
        ) : null}
        <span
          className={clsx(
            'ms-auto inline-flex shrink-0 items-center overflow-hidden transition-[opacity,max-width,margin] duration-300 ease-out',
            showOpenIndicator && !opts.collapsed
              ? 'max-w-[6rem] opacity-100'
              : 'max-w-0 opacity-0',
          )}
        >
          <span className="inline-flex items-center rounded-md border border-green-200 bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none text-neutral-950">
            {openTradesTag}
          </span>
        </span>
        <Flame
          className={clsx(
            'ms-auto h-3.5 w-3.5 shrink-0 text-orange-500 transition-[opacity,max-width,margin] duration-300 ease-out',
            showFireIndicator && !opts.collapsed && !showOpenIndicator
              ? 'max-w-[1rem] opacity-100'
              : 'max-w-0 opacity-0',
          )}
          aria-hidden
        />
      </>
    )
  }

  const renderNav = (opts: { collapsed: boolean; onNavigate?: () => void }) => (
    <>
      {navSections.map(section => {
        const sectionItems = section.items.map(item => ({
          ...item,
          disabled: false,
        }))

        return (
        <div key={section.label}>
          <p
            className={clsx(
              'mb-1 overflow-hidden px-3 whitespace-nowrap transition-[opacity,max-height,margin] duration-300 ease-out',
              APP_SECTION_LABEL,
              opts.collapsed ? 'mb-0 max-h-0 opacity-0' : 'max-h-5 opacity-100',
            )}
          >
            {section.label}
          </p>
          <div className="space-y-0">
            {sectionItems.map(({
              to,
              label,
              showOpenTradesIndicator,
              showHighImpactNewsIndicator,
              showSignalSourceIcons,
              disabled,
            }) => {
              const Icon = getAppRouteIcon(to)
              const ariaExtra = showOpenTradesIndicator && openTradeCount > 0
                ? interpolate(t.nav.openTradesCount, { count: openTradeCount })
                : showHighImpactNewsIndicator && hasHighImpactNewsToday
                  ? t.nav.highImpactNewsToday
                  : null

              if (disabled) {
                return (
                  <button
                    type="button"
                    key={to}
                    title={label}
                    aria-label={ariaExtra ? `${label}, ${ariaExtra}` : label}
                    onClick={() => {
                      openUpgrade('advanced')
                      opts.onNavigate?.()
                    }}
                    className={clsx(navLinkClass(opts.collapsed, true)({ isActive: false }), 'w-full text-start')}
                  >
                    {renderNavItemContent(opts, {
                      icon: Icon,
                      label,
                      isActive: false,
                      showOpenTradesIndicator,
                      showHighImpactNewsIndicator,
                      showSignalSourceIcons,
                    })}
                  </button>
                )
              }

              return (
                <NavLink
                  key={to}
                  to={to}
                  title={label}
                  aria-label={ariaExtra ? `${label}, ${ariaExtra}` : label}
                  onClick={opts.onNavigate}
                  className={navLinkClass(opts.collapsed)}
                >
                  {({ isActive }) => (
                    renderNavItemContent(opts, {
                      icon: Icon,
                      label,
                      isActive,
                      showOpenTradesIndicator,
                      showHighImpactNewsIndicator,
                      showSignalSourceIcons,
                    })
                  )}
                </NavLink>
              )
            })}
          </div>
        </div>
        )
      })}
    </>
  )

  return (
    <div className={clsx('flex h-full min-h-0 w-full flex-col overflow-hidden overscroll-none text-neutral-900 dark:text-neutral-50', APP_CANVAS)}>
      {mobileNavOpen && (
        <button
          type="button"
          aria-label={t.nav.closeMenu}
          className="fixed inset-0 z-40 bg-neutral-900/40 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <AppSearchProvider headerEl={headerEl}>
        <header
          ref={setHeaderEl}
          className={clsx(
            'z-30 flex shrink-0 touch-none items-center gap-1.5 px-2 sm:gap-3 sm:px-4',
            'fixed inset-x-0 top-(--app-banner-h,0px) h-[calc(3.5rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)] sm:h-[calc(4rem+env(safe-area-inset-top,0px))]',
            'bg-white/95 backdrop-blur dark:bg-neutral-950/95',
            'lg:static lg:z-20 lg:h-auto lg:min-h-0 lg:gap-2 lg:bg-transparent lg:px-3 lg:py-2.5 lg:pt-2.5 lg:backdrop-blur-none lg:dark:bg-transparent lg:touch-auto',
          )}
        >
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className={clsx('shrink-0 p-1.5 text-neutral-700 transition-colors sm:p-2 lg:hidden', APP_PILL, 'hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800')}
            aria-label={t.nav.openMenu}
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Logo column matches sidebar width so search sits on the main content edge. */}
          <div
            className={clsx(
              'hidden shrink-0 items-center transition-[width] duration-300 ease-out lg:flex',
              isSidebarCollapsed ? 'w-20 justify-center' : 'w-64',
            )}
          >
            <Link
              to="/dashboard"
              className="flex shrink-0 items-center transition-transform duration-300 ease-out"
              aria-label={t.nav.items.dashboard}
            >
              <TscopierLogo
                brand="unicopier"
                collapsed={isSidebarCollapsed}
                className={clsx(
                  'transition-[width,height,opacity] duration-300 ease-out',
                  isSidebarCollapsed ? undefined : 'h-9 w-auto lg:h-11',
                )}
              />
            </Link>
          </div>

          <Link
            to="/dashboard"
            className="flex shrink-0 items-center lg:hidden"
            aria-label={t.nav.items.dashboard}
          >
            <TscopierLogo brand="unicopier" className="h-9 w-auto" />
          </Link>

          <div className="relative z-40 flex min-w-0 flex-1 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setIsSidebarCollapsed(prev => !prev)}
              title={isSidebarCollapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
              className={clsx(
                'hidden h-9 w-9 shrink-0 items-center justify-center text-neutral-600 transition-colors lg:inline-flex dark:text-neutral-300',
                APP_PILL,
                'hover:bg-neutral-50 dark:hover:bg-neutral-800',
              )}
            >
              {isSidebarCollapsed ? <DirectionalIcon icon={PanelLeftOpen} className="w-4.5 h-4.5" /> : <DirectionalIcon icon={PanelLeftClose} className="w-4.5 h-4.5" />}
            </button>
            <AppSearchDesktop className="hidden w-[min(100%,18rem)] shrink-0 lg:block" />

            <div className="min-w-0 flex-1" />

            <div className="relative z-40 flex shrink-0 items-center gap-1 sm:gap-1.5">
            {hasActiveSubscription && effectivePlan === 'basic' ? (
              <button
                type="button"
                onClick={() => openUpgrade('advanced')}
                className="hidden sm:inline-flex items-center rounded-full bg-teal-50 px-2.5 py-1.5 text-xs font-semibold text-green-600 shadow-xs ring-1 ring-teal-200/80 transition-colors hover:bg-teal-100 dark:bg-teal-950/40 dark:text-teal-300 dark:ring-teal-800"
              >
                {subscribeCta}
              </button>
            ) : null}
            <CopierPauseToggle />
            <button
              type="button"
              onClick={handleAssistantTrigger}
              aria-label={t.nav.assistant.ariaLabel}
              title={t.nav.assistant.title}
              className={clsx(
                'inline-flex h-9 w-9 items-center justify-center text-green-500 transition-colors sm:h-10 sm:w-10',
                APP_PILL,
                'hover:bg-teal-50 focus:outline-hidden focus:ring-2 focus:ring-green-400/30',
                'dark:text-teal-300 dark:hover:bg-teal-950/50',
              )}
            >
              <Sparkles className="h-5 w-5" aria-hidden />
            </button>
            <AppSearchMobileTrigger />
            <LanguageSwitcher className="hidden lg:block" />
            <ThemeToggle className="hidden lg:block" />
            <NotificationBell
              open={notificationsOpen}
              onOpen={() => {
                setUserMenuOpen(false)
                setNotificationsOpen(true)
              }}
              onClose={() => setNotificationsOpen(false)}
            />

            <div
              ref={userMenuRef}
              className="relative shrink-0"
              onMouseEnter={openUserMenu}
              onMouseLeave={scheduleCloseUserMenu}
            >
              <button
                type="button"
                onClick={() => {
                  if (!window.matchMedia('(hover: hover)').matches) {
                    setNotificationsOpen(false)
                    setUserMenuOpen(open => !open)
                  }
                }}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                aria-label={t.nav.userMenu.menuLabel}
                className={clsx(
                  'flex min-h-10 items-center gap-2 ps-1 pe-1.5 transition-colors sm:min-h-[44px] sm:pe-2',
                  APP_PILL,
                  userMenuOpen
                    ? 'bg-neutral-100 dark:bg-neutral-800'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
                )}
              >
                <UserAvatar user={user} profile={profile} email={user?.email} size="sm" />
                <div className="hidden md:block text-start">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 leading-tight truncate max-w-32">
                    {displayName}
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-tight">{planName || t.nav.planFree}</p>
                </div>
                <ChevronDown
                  className={clsx(
                    'hidden md:block w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400 shrink-0 transition-transform',
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
          </div>
        </header>
      </AppSearchProvider>

      <div className="relative flex min-h-0 min-w-0 flex-1 gap-2 overflow-hidden overscroll-none px-0 pb-0 lg:px-3 lg:pb-3">
        <aside
          className={clsx(
            'fixed inset-y-0 left-0 z-50 flex min-h-0 flex-col overflow-hidden transition-[width,transform] duration-300 ease-out max-lg:overflow-visible rtl:left-auto rtl:right-0',
            'w-64 max-w-[85vw]',
            mobileNavOpen ? 'translate-x-0' : 'max-lg:-translate-x-full max-lg:rtl:translate-x-full',
            'lg:relative lg:inset-auto lg:z-30 lg:h-full lg:max-w-none lg:translate-x-0 lg:shrink-0',
            APP_RAIL,
            'max-lg:rounded-none max-lg:shadow-xl',
            isSidebarCollapsed ? 'lg:w-20' : 'lg:w-64',
          )}
        >
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-neutral-200/70 px-2 dark:border-white/8 lg:hidden">
            <Link
              to="/dashboard"
              className="flex shrink-0 items-center"
              aria-label={t.nav.items.dashboard}
              onClick={() => setMobileNavOpen(false)}
            >
              <TscopierLogo brand="unicopier" className="h-6 w-auto" />
            </Link>
            <div className="flex shrink-0 items-center gap-0.5">
              <LanguageSwitcher compact className="max-lg:[&>button]:gap-0 max-lg:[&>button]:px-2" />
              <ThemeToggle />
              <button
                type="button"
                className={clsx(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-neutral-700 dark:text-neutral-200',
                  APP_RAIL_HOVER,
                )}
                aria-label={t.nav.closeMenu}
                onClick={() => setMobileNavOpen(false)}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <nav className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-2.5 py-2">
            {renderNav({
              collapsed: !sidebarExpanded,
              onNavigate: () => setMobileNavOpen(false),
            })}
            <HelpSidebarNav
              collapsed={!sidebarExpanded}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </nav>
        </aside>

        <main
          className={clsx(
            'min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain',
            APP_MAIN_SHELL,
            'max-lg:rounded-none max-lg:ring-0',
            'pt-[calc(3.5rem+env(safe-area-inset-top,0px))] sm:pt-[calc(4rem+env(safe-area-inset-top,0px))]',
            'lg:pt-0',
          )}
        >
          <DashboardKeepAlive />
          {!deferAppBootstrap && !onDashboardRoute && <Outlet />}
        </main>
      </div>
      {!deferAppBootstrap ? (
        <div
          className="pointer-events-none fixed bottom-4 inset-e-4 z-70 flex w-[min(100vw-2rem,22rem)] flex-col gap-2"
          aria-live="polite"
        >
          <CopierProcessToasts userId={user?.id} embedded />
          <CopierLogToasts userId={user?.id} embedded />
        </div>
      ) : null}
    </div>
  )
}
