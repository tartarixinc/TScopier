import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Settings, History, Send, LayoutTemplate, ScrollText, Newspaper, Calendar, TrendingUp, GitBranch, ChartBar as BarChart2, Briefcase, ChartPie as PieChart, Search, Bell, ChevronDown, LogOut, ChartNoAxesColumn, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import tscopierLogo from '/tscopierlogo.png'
import tscopierLogoCollapsed from '/tslogo-collapse.png'
import clsx from 'clsx'
import { useAuth } from '../../context/AuthContext'

interface NavSection {
  label: string
  items: { to: string; icon: React.ElementType; label: string; disabled?: boolean }[]
}

const navSections: NavSection[] = [
  {
    label: 'GENERAL',
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/account-configuration', icon: Settings, label: 'Account & Configuration' },
      { to: '/account-trades', icon: History, label: 'Account Trades' },
    ],
  },
  {
    label: 'SIGNALS',
    items: [
      { to: '/copier-engine', icon: Send, label: 'Channels' },
      { to: '/copier-templates', icon: LayoutTemplate, label: 'Backtest' },
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
      { to: '/integrations', icon: GitBranch, label: 'Integrations' },
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
]

export function AppLayout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  const initials = user?.email?.slice(0, 2).toUpperCase() ?? 'U'
  const displayName = user?.email?.split('@')[0] ?? 'User'

  return (
    <div className="flex h-[100dvh] min-h-0 w-full overflow-hidden bg-neutral-50">
      {/* Sidebar */}
      <aside
        className={clsx(
          'sticky top-0 z-30 flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-neutral-100 bg-white transition-all duration-200',
          isSidebarCollapsed ? 'w-20' : 'w-64'
        )}
      >
        {/* Logo */}
        <div
          className={clsx(
            'flex h-16 shrink-0 items-center border-b border-neutral-100',
            isSidebarCollapsed ? 'justify-center px-2' : 'px-5'
          )}
        >
          <img
            src={isSidebarCollapsed ? tscopierLogoCollapsed : tscopierLogo}
            alt="TSCopier"
            className={clsx(
              'transition-all duration-200',
              isSidebarCollapsed ? 'h-10 w-10 object-contain' : 'h-8 w-auto'
            )}
          />
        </div>

        {/* Nav */}
        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {navSections.map(section => (
            <div key={section.label}>
              <p className={clsx('px-3 text-[10px] font-semibold text-neutral-400 tracking-widest mb-1.5', isSidebarCollapsed && 'hidden')}>
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map(({ to, icon: Icon, label, disabled }) =>
                  disabled ? (
                    <div
                      key={to}
                      title={label}
                      className={clsx(
                        'flex items-center rounded-lg px-3 py-2 text-sm text-neutral-300 cursor-not-allowed select-none',
                        isSidebarCollapsed ? 'justify-center' : 'gap-3'
                      )}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {!isSidebarCollapsed && label}
                    </div>
                  ) : (
                    <NavLink
                      key={to}
                      to={to}
                      title={label}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                          isSidebarCollapsed ? 'justify-center' : 'gap-3',
                          isActive
                            ? 'bg-teal-50 text-teal-700'
                            : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900'
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon className={clsx('w-4 h-4 flex-shrink-0', isActive ? 'text-teal-600' : '')} />
                          {!isSidebarCollapsed && label}
                        </>
                      )}
                    </NavLink>
                  )
                )}
              </div>
            </div>
          ))}
        </nav>

        {/* User bottom */}
        <div className="shrink-0 border-t border-neutral-100 px-3 py-3">
          <button
            onClick={handleSignOut}
            title="Sign out"
            className={clsx(
              'flex w-full items-center rounded-lg px-3 py-2 text-sm text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900',
              isSidebarCollapsed ? 'justify-center' : 'gap-2.5'
            )}
          >
            <LogOut className="w-4 h-4" />
            {!isSidebarCollapsed && 'Sign out'}
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-4 border-b border-neutral-100 bg-white px-6">
          <button
            onClick={() => setIsSidebarCollapsed(prev => !prev)}
            title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 transition-colors"
          >
            {isSidebarCollapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
          </button>

          {/* Search */}
          <div className="flex-1 max-w-sm">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
              <input
                type="text"
                placeholder="Search"
                className="w-full pl-9 pr-4 py-2 text-sm bg-neutral-50 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder:text-neutral-400"
              />
            </div>
          </div>

          <div className="flex-1" />

          {/* Right side */}
          <div className="flex items-center gap-3">
            <button className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-100 transition-colors">
              <Settings className="w-5 h-5" />
            </button>
            <button className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-100 transition-colors">
              <Bell className="w-5 h-5" />
            </button>

            {/* User avatar */}
            <button className="flex items-center gap-2.5 pl-1">
              <div className="w-8 h-8 rounded-full bg-teal-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                {initials}
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-neutral-900 leading-tight">{displayName}</p>
                <p className="text-xs text-neutral-400 leading-tight">Free</p>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
