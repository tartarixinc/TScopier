import { LogOut } from 'lucide-react'
import clsx from 'clsx'
import { NavLink, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

export function AppShell() {
  const { user } = useAuth()

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  const navClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'rounded-lg px-3 py-1.5 text-xs font-medium',
      isActive ? 'bg-green-500 text-neutral-950' : 'text-neutral-600 hover:bg-neutral-50',
    )

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-base font-semibold text-neutral-900">UniCopier Support</h1>
            <p className="text-xs text-neutral-500">{user?.email}</p>
          </div>
          <nav className="flex gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-1">
            <NavLink to="/" end className={navClass}>
              Inbox
            </NavLink>
            <NavLink to="/tickets" className={navClass}>
              Tickets
            </NavLink>
          </nav>
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
