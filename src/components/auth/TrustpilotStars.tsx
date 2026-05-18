import clsx from 'clsx'

interface TrustpilotStarsProps {
  className?: string
  size?: 'sm' | 'md'
}

export function TrustpilotStars({ className, size = 'md' }: TrustpilotStarsProps) {
  const starClass = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'
  return (
    <div
      className={clsx('flex items-center justify-center gap-0.5', className)}
      role="img"
      aria-label="5 out of 5 stars"
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <svg key={i} viewBox="0 0 24 24" className={clsx(starClass, 'text-emerald-500')} aria-hidden>
          <path
            fill="currentColor"
            d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z"
          />
        </svg>
      ))}
    </div>
  )
}

export function TrustpilotBadge({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-emerald-500" aria-hidden>
        <path
          fill="currentColor"
          d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z"
        />
      </svg>
      <span>{label}</span>
    </div>
  )
}
