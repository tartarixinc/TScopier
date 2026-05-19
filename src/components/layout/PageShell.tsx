import clsx from 'clsx'
import type { ReactNode } from 'react'

const maxWidthClass = {
  sm: 'max-w-3xl',
  md: 'max-w-5xl',
  lg: 'max-w-6xl',
  xl: 'max-w-[1600px]',
} as const

export type PageShellMaxWidth = keyof typeof maxWidthClass

interface PageShellProps {
  children: ReactNode
  maxWidth?: PageShellMaxWidth
  className?: string
  /** Gap between stacked sections (header, filters, main content). */
  spacing?: 'default' | 'loose' | 'none'
}

export function PageShell({
  children,
  maxWidth = 'lg',
  className,
  spacing = 'default',
}: PageShellProps) {
  return (
    <div
      className={clsx(
        'mx-auto w-full px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8',
        maxWidthClass[maxWidth],
        spacing === 'default' && 'space-y-6',
        spacing === 'loose' && 'space-y-8',
        className,
      )}
    >
      {children}
    </div>
  )
}
