import clsx from 'clsx'
import { AlertCircle } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useT } from '../context/LocaleContext'
import { getLiveFeedStatus, subscribeLiveFeed } from '../lib/liveFeedStatus'

interface LiveFeedDegradedBannerProps {
  className?: string
}

/**
 * Warning shown while the LIVE broker feed cannot be reached ("broker
 * infrastructure trouble"). Driven entirely by `liveFeedStatus`: it appears
 * when a live read fails and clears itself on the next successful read —
 * no reload, no dismiss button. Same warning styling as the copier-engine
 * offline banner so degraded states look consistent across the app.
 */
export function LiveFeedDegradedBanner({ className }: LiveFeedDegradedBannerProps) {
  const t = useT()
  const status = useSyncExternalStore(subscribeLiveFeed, getLiveFeedStatus, getLiveFeedStatus)

  if (!status.degraded) return null

  return (
    <div
      role="status"
      className={clsx(
        'px-4 py-3 bg-warning-50 dark:bg-amber-950/40 border border-warning-200 dark:border-amber-800 rounded-xl text-sm text-warning-800 dark:text-amber-100 flex items-start gap-2',
        className,
      )}
    >
      <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <div>
        <p className="font-medium">{t.common.brokerFeedDegraded}</p>
        <p className="text-xs mt-0.5 opacity-90">{t.common.brokerFeedDegradedHint}</p>
      </div>
    </div>
  )
}
