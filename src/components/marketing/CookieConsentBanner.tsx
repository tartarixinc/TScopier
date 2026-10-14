import { useState } from 'react'
import { useLocale } from '../../context/LocaleContext'
import { marketingUrl } from '../../lib/site'
import {
  markTrackingConsentAccepted,
  markTrackingConsentDismissed,
  shouldShowTrackingBanner,
} from '../../lib/trackingConsent'

export function CookieConsentBanner() {
  const { locale, t } = useLocale()
  const [visible, setVisible] = useState(() => shouldShowTrackingBanner())
  const c = t.common.cookieConsent

  if (!visible) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 px-3 pb-3 sm:px-6 sm:pb-6">
      <div className="mx-auto max-w-5xl rounded-xl border border-neutral-200 bg-white/95 p-4 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95">
        <p key={locale} className="text-sm text-neutral-900 dark:text-neutral-50">
          {c.message}{' '}
          <a
            href={marketingUrl('/cookie-policy')}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-green-400 hover:underline dark:text-green-400"
          >
            {c.policyLink}
          </a>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-lg bg-green-400 px-3 py-2 text-sm font-semibold text-neutral-950 transition-colors hover:bg-green-500"
            onClick={() => {
              markTrackingConsentAccepted()
              setVisible(false)
            }}
          >
            {c.accept}
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-50 dark:hover:bg-neutral-700"
            onClick={() => {
              markTrackingConsentDismissed()
              setVisible(false)
            }}
          >
            {c.dismiss}
          </button>
        </div>
      </div>
    </div>
  )
}

