import { Outlet } from 'react-router-dom'
import tscopierLogo from '/tscopierlogo.png'
import { ThemeToggle } from '../ui/ThemeToggle'

export function AuthLayout() {
  return (
    <div className="relative min-h-screen bg-gradient-to-br from-primary-950 via-primary-900 to-primary-800 flex items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle className="text-white/70 hover:text-white hover:bg-white/10 dark:hover:bg-white/10" />
      </div>
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex items-center justify-center mb-8">
          <img src={tscopierLogo} alt="TSCopier" className="h-10 w-auto" />
        </div>

        <Outlet />

        <p className="text-center text-white/40 text-xs mt-6">
          One seamless copier for every Telegram signal
        </p>
      </div>
    </div>
  )
}
