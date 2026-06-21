import clsx from 'clsx'

interface LocaleFlagProps {
  flagId: string
  className?: string
  title?: string
}

/** Country flag sprite from `public/flags.svg` (flag id ≠ language code). */
export function LocaleFlag({ flagId, className, title }: LocaleFlagProps) {
  return (
    <svg
      viewBox="0 0 3 2"
      className={clsx('shrink-0 overflow-hidden rounded-[2px] border border-black/10 dark:border-white/10', className)}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    >
      <use href={`/flags.svg#${flagId}`} />
    </svg>
  )
}
