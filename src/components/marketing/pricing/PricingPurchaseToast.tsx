import clsx from 'clsx'

interface PricingPurchaseToastProps {
  message: string
  timeAgo: string
  flag: string
  visible: boolean
  reduceMotion: boolean
}

export function PricingPurchaseToast({ message, timeAgo, flag, visible, reduceMotion }: PricingPurchaseToastProps) {
  if (!message) return null

  return (
    <div
      className={clsx(
        'pointer-events-none fixed left-4 bottom-4 z-40 sm:left-6 sm:bottom-6',
        !reduceMotion && 'transition-all duration-300 ease-out',
        visible
          ? 'translate-y-0 opacity-100'
          : 'translate-y-2 opacity-0',
      )}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex max-w-sm items-start gap-3 rounded-xl border border-teal-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur dark:border-teal-900/50 dark:bg-neutral-900/95">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-100 text-xl leading-none dark:bg-teal-950/60"
          aria-hidden
        >
          {flag}
        </span>
        <div className="min-w-0">
          <p className="text-sm leading-snug text-neutral-800 dark:text-neutral-100">{message}</p>
          {timeAgo ? (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{timeAgo}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
