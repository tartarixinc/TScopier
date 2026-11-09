import clsx from 'clsx'
import { NavLink, Outlet } from 'react-router-dom'
import { UserMenu } from './UserMenu'

export function AppShell() {
  const navClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'rounded-lg px-3 py-1.5 text-xs font-medium',
      isActive ? 'bg-green-500 text-neutral-950' : 'text-neutral-600 hover:bg-neutral-50',
    )

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
        <div className="flex items-center gap-4">
          <img
            src="/uni-support-logo.png"
            alt="uni Support"
            className="h-8 w-auto rounded-md"
            draggable={false}
          />
          <nav className="flex gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-1">
            <NavLink to="/" end className={navClass}>
              Inbox
            </NavLink>
            <NavLink to="/tickets" className={navClass}>
              Tickets
            </NavLink>
          </nav>
        </div>
        <UserMenu />
      </header>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
