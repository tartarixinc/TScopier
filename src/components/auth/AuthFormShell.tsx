import type { ReactNode } from 'react'
import clsx from 'clsx'

interface AuthFormShellProps {
  title: string
  subtitle: string
  children: ReactNode
  footer: ReactNode
  className?: string
}

export function AuthFormShell({ title, subtitle, children, footer, className }: AuthFormShellProps) {
  return (
    <div
      className={clsx(
        'w-full animate-slide-up rounded-2xl border border-neutral-200/80 dark:border-neutral-800',
        'bg-white dark:bg-neutral-900 shadow-card-lg dark:shadow-none',
        'p-6 sm:p-8',
        className,
      )}
    >
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
          {title}
        </h1>
        <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
          {subtitle}
        </p>
      </header>
      {children}
      <footer className="mt-6 pt-6 border-t border-neutral-100 dark:border-neutral-800">
        {footer}
      </footer>
    </div>
  )
}
