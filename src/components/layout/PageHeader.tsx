import clsx from 'clsx'
import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
  /** When actions are wide (e.g. period tabs), stack until large screens. */
  actionsBreakpoint?: 'sm' | 'lg'
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
  actionsBreakpoint = 'sm',
}: PageHeaderProps) {
  const rowAtLg = actionsBreakpoint === 'lg'

  return (
    <header
      className={clsx(
        'flex flex-col gap-4',
        rowAtLg
          ? 'lg:flex-row lg:items-start lg:justify-between'
          : 'sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div
          className={clsx(
            'flex shrink-0 flex-col items-stretch gap-2',
            rowAtLg ? 'lg:items-end' : 'sm:items-end',
          )}
        >
          {actions}
        </div>
      ) : null}
    </header>
  )
}
