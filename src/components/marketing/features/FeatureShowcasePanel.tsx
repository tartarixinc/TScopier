import clsx from 'clsx'
import type { ReactNode } from 'react'

interface FeatureShowcasePanelProps {
  eyebrow: string
  title: string
  description: string
  visual: ReactNode
  reverse?: boolean
}

export function FeatureShowcasePanel({
  eyebrow,
  title,
  description,
  visual,
  reverse = false,
}: FeatureShowcasePanelProps) {
  return (
    <article className="marketing-feature-panel">
      <div className="marketing-grid-pattern" aria-hidden />
      <div
        className={clsx(
          'relative grid items-center gap-10 p-6 sm:p-8 lg:grid-cols-2 lg:gap-12 lg:p-10',
          reverse && 'lg:[&>*:first-child]:order-2',
        )}
      >
        <div className="marketing-feature-visual min-h-[280px] sm:min-h-[320px]">{visual}</div>
        <div className="flex flex-col justify-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
            {eyebrow}
          </p>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
            {title}
          </h3>
          <p className="mt-4 text-base leading-relaxed text-neutral-600 dark:text-neutral-400">
            {description}
          </p>
        </div>
      </div>
    </article>
  )
}
