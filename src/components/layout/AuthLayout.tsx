import { Link, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import { AuthReviewsPanel } from '../auth/AuthReviewsPanel'
import { AuthPage } from '../../pages/auth/AuthPage'
import { ForgotPasswordPage } from '../../pages/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '../../pages/auth/ResetPasswordPage'
import { SignupPage } from '../../pages/auth/SignupPage'
import { VerifyEmailPage } from '../../pages/auth/VerifyEmailPage'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { ThemeToggle } from '../ui/ThemeToggle'
import { AuthBrandLogo } from '../auth/AuthBrandLogo'
import { useLocale } from '../../context/LocaleContext'

export function AuthLayout() {
  const { auth } = useLocale()
  const { pathname } = useLocation()
  const isSignup = pathname === '/signup'
  const isVerify = pathname === '/verify-email'
  const isForgotPassword = pathname === '/forgot-password'
  const isResetPassword = pathname === '/reset-password'
  const year = new Date().getFullYear()
  const copyright = auth.marketing.copyright.replace('{year}', String(year))

  return (
    <div className="flex min-h-[100dvh] flex-col bg-white dark:bg-neutral-950 lg:min-h-screen lg:flex-row">
      <main className="relative flex w-full flex-1 flex-col lg:min-h-screen lg:w-1/2">
        <header
          className={clsx(
            'z-20 flex shrink-0 touch-none items-center justify-between bg-white px-5 dark:bg-neutral-950 sm:px-8',
            'fixed inset-x-0 top-[var(--app-banner-h,0px)] h-[calc(4rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)]',
            'lg:static lg:z-auto lg:h-auto lg:px-10 lg:py-4 lg:touch-auto',
          )}
        >
          <Link to="/" className="flex items-center" aria-label="TSCopier home">
            <AuthBrandLogo className="h-8 w-auto sm:h-6" />
          </Link>
          <div className="flex items-center gap-1 sm:gap-1.5">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>

        <div
          className={clsx(
            'flex flex-1 flex-col px-5 pb-[env(safe-area-inset-bottom,0px)] sm:px-8 lg:px-10',
            'pt-[calc(4rem+env(safe-area-inset-top,0px)+var(--app-banner-h,0px))] lg:pt-0',
          )}
        >
          <div className="mx-auto flex w-full max-w-[420px] flex-col py-6 lg:flex-1 lg:justify-center lg:py-8">
            {isVerify ? (
              <VerifyEmailPage />
            ) : isResetPassword ? (
              <ResetPasswordPage />
            ) : isForgotPassword ? (
              <ForgotPasswordPage />
            ) : isSignup ? (
              <SignupPage />
            ) : (
              <AuthPage />
            )}
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
