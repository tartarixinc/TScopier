interface PricingSocialProofBannerProps {
  message: string
  variant?: 'marketing' | 'app'
}

export function PricingSocialProofBanner(props: PricingSocialProofBannerProps) {
  void props
  return null
}

/*
import clsx from 'clsx'
import { Zap } from 'lucide-react'

export function PricingSocialProofBanner({ message, variant = 'marketing' }: PricingSocialProofBannerProps) {
  const isApp = variant === 'app'

  return (
    <div
      role="status"
      className={clsx(
        'mx-auto max-w-6xl',
        isApp ? 'mb-4 px-0' : 'mb-6 px-5 sm:px-8',
      )}
    >
      <div className="flex items-center justify-center gap-2.5 rounded-xl border border-teal-200 bg-teal-50/80 px-4 py-3 text-center text-sm font-medium text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/40 dark:text-teal-100">
        <Zap className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
        <span>{message}</span>
      </div>
    </div>
  )
}
*/
