import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { AuthReviewsPanel } from '../auth/AuthReviewsPanel'
import { AuthPage } from '../../pages/auth/AuthPage'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { ThemeToggle } from '../ui/ThemeToggle'
import { TscopierLogo } from '../ui/TscopierLogo'
import { useLocale } from '../../context/LocaleContext'

export function AuthLayout() {
  const { auth } = useLocale()
  const year = new Date().getFullYear()
  const copyright = auth.marketing.copyright.replace('{year}', String(year))

  useEffect(() => {
    document.documentElement.classList.add('app-viewport-lock')
    return () => document.documentElement.classList.remove('app-viewport-lock')
  }, [])

  return (
    <div className="flex min-h-[100dvh] flex-col bg-white dark:bg-neutral-950 lg:min-h-screen lg:flex-row">
      <main className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:min-h-screen lg:w-1/2 lg:overflow-visible">
        <header
          className={clsx(
            'z-20 flex shrink-0 touch-none items-center justify-between bg-white px-5 dark:bg-neutral-950 sm:px-8',
            'fixed inset-x-0 top-0 h-[calc(4rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)]',
            'lg:static lg:z-auto lg:h-auto lg:px-10 lg:py-4 lg:touch-auto',
          )}
        >
          <Link to="/login" className="flex items-center">
            <TscopierLogo className="h-8 w-auto sm:h-6" />
          </Link>
          <div className="flex items-center gap-1 sm:gap-1.5">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>

        <div
          className={clsx(
            'flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain px-5 sm:px-8 lg:overflow-visible lg:px-10',
            'pt-[calc(4rem+env(safe-area-inset-top,0px))] lg:pt-0',
          )}
        >
          <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center py-6 lg:py-8">
            <h1 className="mb-8 max-w-md text-2xl font-semibold leading-tight tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
              {auth.marketing.headline}
            </h1>

            <AuthPage />
          </div>

          <footer className="mx-auto w-full max-w-[420px] shrink-0 pb-6 pt-4 lg:pb-8">
            <p className="text-xs text-neutral-400 dark:text-neutral-500">{copyright}</p>
          </footer>
        </div>
      </main>

      <AuthReviewsPanel />
    </div>
  )
}
