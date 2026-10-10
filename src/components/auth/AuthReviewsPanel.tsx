import clsx from 'clsx'
import { AuthTrustpilotSlider } from './AuthTrustpilotSlider'
import { useLocale } from '../../context/LocaleContext'

export function AuthReviewsPanel() {
  const { auth } = useLocale()
  const { marketing: m } = auth

  return (
    <aside className="trustpilot-panel-bg relative hidden min-h-screen w-full flex-col p-6 lg:flex lg:w-1/2 xl:p-10">
      <div
        className={clsx(
          'trustpilot-panel-surface relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-3xl',
          'border border-neutral-200/55 px-8 py-10 dark:border-neutral-800/55 xl:px-12 xl:py-14',
        )}
      >
        <div className="trustpilot-panel-radial" aria-hidden />
        <div className="relative z-10 flex w-full max-w-lg flex-col items-center justify-center">
          <AuthTrustpilotSlider reviews={m.reviews} trustpilotLabel={m.trustpilotLabel} />
        </div>
      </div>
    </aside>
  )
}
