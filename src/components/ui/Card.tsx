import clsx from 'clsx'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

interface CardProps extends ComponentPropsWithoutRef<'div'> {
  children: ReactNode
  className?: string
  padding?: 'sm' | 'md' | 'lg' | 'none'
}

export function Card({ children, className, padding = 'md', ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        'bg-white dark:bg-neutral-950 rounded-2xl border border-neutral-200/65 dark:border-neutral-800/55',
        {
          'p-4': padding === 'sm',
          'p-6': padding === 'md',
          'p-8': padding === 'lg',
          '': padding === 'none',
        },
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}
