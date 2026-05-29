import clsx from 'clsx'
import type { ReactNode } from 'react'

type AlertVariant = 'error' | 'warning' | 'success'

interface AlertProps {
  children: ReactNode
  variant?: AlertVariant
  className?: string
}

const variantClass: Record<AlertVariant, string> = {
  error:
    'bg-error-50 border-error-200 text-error-800 dark:!bg-error-950 dark:!border-error-800 dark:!text-error-200',
  warning:
    'bg-warning-50 border-warning-200 text-warning-800 dark:!bg-amber-900 dark:!border-amber-800 dark:!text-amber-100',
  success:
    'bg-success-50 border-green-200 text-success-800 dark:!bg-success-950 dark:!border-green-900 dark:!text-success-200',
}

export function Alert({ children, variant = 'error', className }: AlertProps) {
  return (
    <div
      role="alert"
      className={clsx(
        'rounded-lg border px-3 py-2 text-sm',
        variantClass[variant],
        className,
      )}
    >
      {children}
    </div>
  )
}
