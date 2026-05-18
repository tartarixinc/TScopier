import { Link } from 'react-router-dom'
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

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-neutral-950 lg:flex-row">
      <main className="relative flex min-h-screen w-full flex-1 flex-col lg:w-1/2">
        <header className="flex shrink-0 items-center justify-between px-5 py-4 sm:px-8 lg:px-10">
          <Link to="/login" className="flex items-center">
            <TscopierLogo className="h-8 w-auto sm:h-6" />
          </Link>
          <div className="flex items-center gap-1 sm:gap-1.5">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col px-5 sm:px-8 lg:px-10">
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
