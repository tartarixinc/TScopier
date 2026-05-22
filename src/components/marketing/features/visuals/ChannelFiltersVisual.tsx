import clsx from 'clsx'
import { useT } from '../../../../context/LocaleContext'
import type { LandingFilterDecision } from '../../../../i18n/locales/landing/types'

function FilterCategoryCard({
  label,
  example,
  decision,
  allowLabel,
  ignoreLabel,
}: {
  label: string
  example: string
  decision: LandingFilterDecision
  allowLabel: string
  ignoreLabel: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="min-w-0">
        <p className="text-sm text-neutral-800 dark:text-neutral-100">{label}</p>
        <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">{example}</p>
      </div>
      <div
        className="inline-flex shrink-0 items-center rounded-md border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-800/50"
        aria-hidden
      >
        <span
          className={clsx(
            'rounded px-2.5 py-1 text-xs',
            decision === 'allow'
              ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-50'
              : 'text-neutral-500 dark:text-neutral-400',
          )}
        >
          {allowLabel}
        </span>
        <span
          className={clsx(
            'rounded px-2.5 py-1 text-xs',
            decision === 'ignore'
              ? 'bg-amber-50 text-amber-700 shadow-sm'
              : 'text-neutral-500 dark:text-neutral-400',
          )}
        >
          {ignoreLabel}
        </span>
      </div>
    </div>
  )
}

export function ChannelFiltersVisual() {
  const v = useT().landing.features.visuals.filters

  return (
    <div className="flex h-full min-h-[280px] items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md space-y-2">
        {v.rules.map((rule) => (
          <FilterCategoryCard
            key={rule.label}
            label={rule.label}
            example={rule.example}
            decision={rule.decision}
            allowLabel={v.allowLabel}
            ignoreLabel={v.ignoreLabel}
          />
        ))}
      </div>
    </div>
  )
}
