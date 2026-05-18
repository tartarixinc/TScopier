import clsx from 'clsx'
import { AuthTrustpilotSlider } from './AuthTrustpilotSlider'
import { useLocale } from '../../context/LocaleContext'

export function AuthReviewsPanel() {
  const { auth } = useLocale()
  const { marketing: m } = auth

  return (
    <aside className="relative hidden min-h-screen w-full flex-col bg-neutral-100 p-6 dark:bg-neutral-900/50 lg:flex lg:w-1/2 xl:p-10">
      <div
        className={clsx(
          'relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-3xl',
          'border border-neutral-200/80 bg-gradient-to-br from-white via-teal-50/40 to-primary-50/30',
          'dark:border-neutral-800 dark:from-neutral-900 dark:via-teal-950/20 dark:to-primary-950/40',
          'px-8 py-10 xl:px-12 xl:py-14',
        )}
      >
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_80%_0%,rgba(45,212,191,0.12),transparent),radial-gradient(ellipse_50%_40%_at_0%_100%,rgba(13,148,136,0.08),transparent)] dark:bg-[radial-gradient(ellipse_70%_50%_at_80%_0%,rgba(45,212,191,0.08),transparent)]"
          aria-hidden
        />
        <div className="relative z-10 flex w-full max-w-lg flex-col items-center justify-center">
          <AuthTrustpilotSlider reviews={m.reviews} trustpilotLabel={m.trustpilotLabel} />
        </div>
      </div>
    </aside>
  )
}
