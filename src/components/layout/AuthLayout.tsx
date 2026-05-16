import { Link, Outlet, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import { AuthMarketingPanel } from '../auth/AuthMarketingPanel'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { ThemeToggle } from '../ui/ThemeToggle'
import { AuthBrandLogo } from '../auth/AuthBrandLogo'
import { TscopierLogo } from '../ui/TscopierLogo'
import { useLocale } from '../../context/LocaleContext'

export function AuthLayout() {
  const { pathname } = useLocation()
  const { auth } = useLocale()
  const isLogin = pathname === '/login'
  const isSignup = pathname === '/signup'

  return (
    <div className="min-h-screen flex bg-neutral-50 dark:bg-neutral-950">
      <AuthMarketingPanel />

      <main className="relative flex flex-1 flex-col min-h-screen">
        <header className="flex items-center justify-between px-5 py-4 sm:px-8">
          <Link to={isLogin ? '/login' : '/signup'} className="lg:hidden flex items-center">
            {isLogin ? (
              <span className="inline-flex rounded-xl bg-primary-950 px-3 py-2">
                <AuthBrandLogo className="h-7 w-auto max-w-[200px]" />
              </span>
            ) : (
              <TscopierLogo className="h-8 w-auto" />
            )}
          </Link>
          <div className="hidden lg:block" aria-hidden />
          <div className="flex items-center gap-1 sm:gap-1.5">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center px-5 pb-10 sm:px-8">
          <div className="w-full max-w-[420px]">
            <nav
              className="mb-6 flex rounded-xl bg-neutral-200/60 dark:bg-neutral-800/80 p-1"
              aria-label="Authentication"
            >
              <Link
                to="/login"
                className={clsx(
                  'flex-1 rounded-lg py-2 text-center text-sm font-medium transition-all',
                  isLogin
                    ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 shadow-sm'
                    : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200',
                )}
              >
                {auth.nav.signIn}
              </Link>
              <Link
                to="/signup"
                className={clsx(
                  'flex-1 rounded-lg py-2 text-center text-sm font-medium transition-all',
                  isSignup
                    ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 shadow-sm'
                    : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200',
                )}
              >
                {auth.nav.createAccount}
              </Link>
            </nav>

            <Outlet />
          </div>
        </div>

        <p className="pb-6 text-center text-xs text-neutral-400 dark:text-neutral-500 lg:hidden">
          {auth.nav.mobileTagline}
        </p>
      </main>
    </div>
  )
}
