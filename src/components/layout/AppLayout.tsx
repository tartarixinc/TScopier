import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Settings, History, Zap, LayoutTemplate, ScrollText, Newspaper, Calendar, TrendingUp, GitBranch, ChartBar as BarChart2, Briefcase, ChartPie as PieChart, Search, Bell, ChevronDown, LogOut } from 'lucide-react'
import tscopierLogo from '/tscopierlogo.png'
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
      { to: '/account-configuration', icon: Settings, label: 'Connections' },
      { to: '/account-trades', icon: History, label: 'Account Trades' },
    ],
  },
  {
    label: 'TS COPIER',
    items: [
      { to: '/copier-engine', icon: Zap, label: 'Copier Engine' },
      { to: '/copier-templates', icon: LayoutTemplate, label: 'Signal Backtest' },
      { to: '/copier-logs', icon: ScrollText, label: 'Copier Logs' },
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
    label: 'TC ANALYZER',
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

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  const initials = user?.email?.slice(0, 2).toUpperCase() ?? 'U'
  const displayName = user?.email?.split('@')[0] ?? 'User'

  return (
    <div className="min-h-screen bg-neutral-50 flex">
      {/* Sidebar */}
      <aside className="w-64 flex-shrink-0 bg-white border-r border-neutral-100 flex flex-col">
        {/* Logo */}
        <div className="h-16 flex items-center px-5 border-b border-neutral-100">
          <img src={tscopierLogo} alt="TSCopier" className="h-8 w-auto" />
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-5">
          {navSections.map(section => (
            <div key={section.label}>
              <p className="px-3 text-[10px] font-semibold text-neutral-400 tracking-widest mb-1.5">
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map(({ to, icon: Icon, label, disabled }) =>
                  disabled ? (
                    <div
                      key={to}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-neutral-300 cursor-not-allowed select-none"
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {label}
                    </div>
                  ) : (
                    <NavLink
                      key={to}
                      to={to}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-teal-50 text-teal-700'
                            : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900'
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon className={clsx('w-4 h-4 flex-shrink-0', isActive ? 'text-teal-600' : '')} />
                          {label}
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
        <div className="px-3 py-3 border-t border-neutral-100">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
        {/* Top bar */}
        <header className="h-16 bg-white border-b border-neutral-100 flex items-center px-6 gap-4 flex-shrink-0">
          <button className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
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
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
