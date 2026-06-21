import { TriangleAlert } from 'lucide-react'
import { useAppBanner } from '../../context/AppBannerContext'

/** Amber warning bar — message from `app_settings.banner_message`. */
export function AppWarningBanner() {
  const { enabled, message } = useAppBanner()

  if (!enabled || !message) return null

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2.5 text-center text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200 sm:px-6"
    >
      <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p className="min-w-0 font-medium leading-snug">{message}</p>
    </div>
  )
}
