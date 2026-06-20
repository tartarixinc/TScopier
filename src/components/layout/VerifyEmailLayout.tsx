import { Link, Outlet } from 'react-router-dom'
import { AuthBrandLogo } from '../auth/AuthBrandLogo'

/** Minimal shell for email verification — no app nav or marketing panels. */
export function VerifyEmailLayout() {
  const year = new Date().getFullYear()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-white dark:bg-neutral-950">
      <header className="flex shrink-0 items-center justify-center px-6 py-8 pt-[calc(2rem+env(safe-area-inset-top,0px)+var(--app-banner-h,0px))]">
        <Link to="/" className="flex items-center" aria-label="TScopier home">
          <AuthBrandLogo className="h-8 w-auto" />
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-6 pb-10">
        <Outlet />
      </main>

      <footer className="shrink-0 px-6 pb-8 text-center">
        <p className="text-xs text-neutral-400 dark:text-neutral-500">© {year} Tartarix Inc.</p>
      </footer>
    </div>
  )
}
