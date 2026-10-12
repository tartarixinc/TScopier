import clsx from 'clsx'

interface BadgeProps {
  children: React.ReactNode
  variant?: 'success' | 'warning' | 'error' | 'neutral' | 'primary'
  size?: 'sm' | 'md'
  className?: string
}

export function Badge({ children, variant = 'neutral', size = 'md', className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 font-medium rounded-full',
        !className && {
          'bg-success-50 text-success-700 dark:bg-success-950/70 dark:text-success-300': variant === 'success',
          'bg-warning-50 text-warning-800 dark:!bg-amber-900 dark:!text-amber-100': variant === 'warning',
          'bg-error-50 text-error-700 dark:bg-error-950/70 dark:text-error-300': variant === 'error',
          'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50': variant === 'neutral',
          'bg-teal-50 text-green-500 dark:bg-teal-950/50 dark:text-green-400': variant === 'primary',
        },
        className,
        {
          'text-xs px-2 py-0.5': size === 'sm',
          'text-xs px-2.5 py-1': size === 'md',
        }
      )}
    >
      {children}
    </span>
  )
}
