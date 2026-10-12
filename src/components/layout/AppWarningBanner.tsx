import { useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { useAppBanner } from '../../context/AppBannerContext'
import { useT } from '../../context/LocaleContext'
import { appBannerRevision } from '../../lib/appBanner'

const DISMISSED_WARNING_KEY = 'tscopier:warning-banner:dismissed'

function readDismissedWarning(): string | null {
  try {
    return localStorage.getItem(DISMISSED_WARNING_KEY)
  } catch {
    return null
  }
}

/** Amber warning bar — message from `app_settings.banner_message`. */
export function AppWarningBanner() {
  const { enabled, message } = useAppBanner()
  const t = useT()
  const revision = appBannerRevision({ enabled, message })
  const [dismissedRevision, setDismissedRevision] = useState<string | null>(readDismissedWarning)

  if (!revision || !message) return null
  if (dismissedRevision === revision) return null

  const hide = () => {
    try {
      localStorage.setItem(DISMISSED_WARNING_KEY, revision)
    } catch {
      /* the in-memory dismissal still hides it for this visit */
    }
    setDismissedRevision(revision)
  }

  return (
    <div
      role="status"
      className="relative flex shrink-0 items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-10 py-2.5 text-center text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200 sm:px-12"
    >
      <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p className="min-w-0 font-medium leading-snug">{message}</p>
      <button
        type="button"
        onClick={hide}
        aria-label={t.nav.updatesAnnouncement.dismiss}
        className="absolute inset-y-0 end-1 my-auto flex h-7 w-7 items-center justify-center rounded-md text-amber-900 transition-colors hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900/70"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
