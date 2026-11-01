import clsx from 'clsx'

const TRUSTPILOT_GREEN = '#00b67a'
const TRUSTPILOT_GRAY = '#dcdce6'

/** Official Trustpilot star silhouette (white star on brand green square). */
const STAR_PATH =
  'M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z'

function trustpilotStarFills(rating: number): number[] {
  return Array.from({ length: 5 }, (_, index) => Math.min(1, Math.max(0, rating - index)))
}

function TrustpilotBox({
  fill,
  sizeClass,
}: {
  fill: number
  sizeClass: string
}) {
  return (
    <div className={clsx('relative shrink-0 overflow-hidden', sizeClass)}>
      <div className="absolute inset-0" style={{ backgroundColor: TRUSTPILOT_GRAY }} />
      {fill > 0 ? (
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${Math.min(fill, 1) * 100}%`, backgroundColor: TRUSTPILOT_GREEN }}
        />
      ) : null}
      <svg viewBox="0 0 24 24" className="relative z-1 h-full w-full p-[3px] text-white" aria-hidden>
        <path fill="currentColor" d={STAR_PATH} />
      </svg>
    </div>
  )
}

interface TrustpilotWidgetProps {
  excellentLabel: string
  trustpilotLabel: string
  rating?: number
  className?: string
}

export function TrustpilotWidget({
  excellentLabel,
  trustpilotLabel,
  rating = 4.8,
  className,
}: TrustpilotWidgetProps) {
  const fills = trustpilotStarFills(rating)

  return (
    <div
      className={clsx(
        'inline-flex flex-nowrap items-center justify-center gap-x-3 sm:gap-x-3.5',
        className,
      )}
    >
      <span className="shrink-0 text-base font-bold text-neutral-900 underline decoration-2 decoration-neutral-900 underline-offset-[3px] dark:text-neutral-50 dark:decoration-neutral-50">
        {excellentLabel}
      </span>
      <div
        className="flex items-center gap-[3px]"
        role="img"
        aria-label={`${rating} out of 5 stars on Trustpilot`}
      >
        {fills.map((fill, index) => (
          <TrustpilotBox key={index} fill={fill} sizeClass="h-[18px] w-[18px] sm:h-5 sm:w-5" />
        ))}
      </div>
      <div className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-50">
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" style={{ color: TRUSTPILOT_GREEN }} aria-hidden>
          <path fill="currentColor" d={STAR_PATH} />
        </svg>
        <span>{trustpilotLabel}</span>
      </div>
    </div>
  )
}

interface TrustpilotStarsProps {
  className?: string
  size?: 'sm' | 'md'
  /** 0–5; supports partial stars (e.g. 4.8). Defaults to 5. */
  rating?: number
}

export function TrustpilotStars({ className, size = 'md', rating = 5 }: TrustpilotStarsProps) {
  const sizeClass = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'
  const fills = trustpilotStarFills(rating)
  return (
    <div
      className={clsx('flex items-center justify-center gap-[3px]', className)}
      role="img"
      aria-label={`${rating} out of 5 stars on Trustpilot`}
    >
      {fills.map((fill, index) => (
        <TrustpilotBox key={index} fill={fill} sizeClass={sizeClass} />
      ))}
    </div>
  )
}

export function TrustpilotBadge({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
      <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" style={{ color: TRUSTPILOT_GREEN }} aria-hidden>
        <path fill="currentColor" d={STAR_PATH} />
      </svg>
      <span>{label}</span>
    </div>
  )
}
