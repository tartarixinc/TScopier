import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useAppBanner } from '../../context/AppBannerContext'

/**
 * Global information banner — enabled flag and message come from
 * `app_settings.banner_message` via {@link AppBannerProvider}.
 *
 * Sits above the sidebar and header. The mobile header is fixed to the
 * viewport top, so the banner publishes its height as `--app-banner-h`
 * for the header to offset itself below the banner.
 */
export function AppBanner() {
  const { enabled, message } = useAppBanner()
  const [el, setEl] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = document.documentElement
    if (!el) {
      root.style.setProperty('--app-banner-h', '0px')
      return
    }
    const update = () => root.style.setProperty('--app-banner-h', `${el.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.setProperty('--app-banner-h', '0px')
    }
  }, [el])

  if (!enabled || !message) return null

  return (
    <div
      ref={setEl}
      role="status"
      className="relative z-50 flex shrink-0 items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2.5 pt-[calc(0.625rem+env(safe-area-inset-top,0px))] text-center text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200 sm:px-6"
    >
      <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p className="min-w-0 font-medium leading-snug">{message}</p>
    </div>
  )
}
