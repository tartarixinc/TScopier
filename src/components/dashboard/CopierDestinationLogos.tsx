import clsx from 'clsx'
import { COPIER_DESTINATION_LOGO_MAX } from '../../lib/copierLogToast'

/**
 * Overlapping broker/platform logos (half-overlap). Shows at most
 * {@link COPIER_DESTINATION_LOGO_MAX} icons.
 */
export function CopierDestinationLogos({
  icons,
  className,
  sizeClassName = 'h-4 w-4',
}: {
  icons: readonly string[]
  className?: string
  sizeClassName?: string
}) {
  const shown = icons.slice(0, COPIER_DESTINATION_LOGO_MAX)
  if (shown.length === 0) return null

  return (
    <span
      className={clsx('inline-flex shrink-0 items-center', className)}
      aria-hidden
    >
      {shown.map((icon, index) => (
        <img
          key={`${icon}-${index}`}
          src={icon}
          alt=""
          className={clsx(
            sizeClassName,
            'relative shrink-0 rounded-full bg-white object-contain ring-1 ring-white dark:bg-neutral-900 dark:ring-neutral-900',
            index > 0 && '-ms-2',
          )}
          style={{ zIndex: shown.length - index }}
        />
      ))}
    </span>
  )
}
