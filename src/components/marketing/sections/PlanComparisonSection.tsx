import clsx from 'clsx'
import { Check, Minus, X } from 'lucide-react'
import { useT } from '../../../context/LocaleContext'
import type { LandingPlanComparisonRow } from '../../../i18n/locales/landing/types'

type PlanKey = 'basic' | 'advanced' | 'custom'

function PlanCell({ value }: { value: LandingPlanComparisonRow['basic'] }) {
  if (value === 'yes') {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-100">
        <Check className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" strokeWidth={2.5} aria-hidden />
        <span className="sr-only">Included</span>
      </span>
    )
  }

  if (value === 'no') {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-neutral-400 dark:text-neutral-500">
        <X className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden />
        <span className="sr-only">Not included</span>
      </span>
    )
  }

  if (value === 'partial') {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
        <Minus className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden />
        <span className="sr-only">Limited</span>
      </span>
    )
  }

  return <span className="text-sm text-neutral-700 dark:text-neutral-300">{value}</span>
}

function MobilePlanCard({
  planLabel,
  row,
  plan,
  highlighted,
}: {
  planLabel: string
  row: LandingPlanComparisonRow
  plan: PlanKey
  highlighted?: boolean
}) {
  return (
    <div
      className={clsx(
        'rounded-xl border px-4 py-3',
        highlighted
          ? 'border-teal-200 bg-teal-50/70 dark:border-teal-900/50 dark:bg-teal-950/40'
          : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900',
      )}
    >
      <p
        className={clsx(
          'mb-2 text-[0.65rem] font-semibold uppercase tracking-wide',
          highlighted ? 'text-teal-700 dark:text-teal-400' : 'text-neutral-500 dark:text-neutral-400',
        )}
      >
        {planLabel}
      </p>
      <PlanCell value={row[plan]} />
    </div>
  )
}

export function PlanComparisonSection({ variant = 'marketing' }: { variant?: 'marketing' | 'app' }) {
  const c = useT().landing.planComparison
  const isApp = variant === 'app'

  return (
    <section
      className={clsx(
        'mx-auto max-w-6xl',
        isApp ? 'px-0 py-8 sm:py-10' : 'px-5 py-16 sm:px-8 sm:py-24',
      )}
    >
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
          {c.eyebrow}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {c.title}
        </h2>
        <p className="mt-4 text-base text-neutral-600 dark:text-neutral-400">{c.subtitle}</p>
      </div>

      <ul className="mt-10 flex flex-col gap-3 sm:mt-12 md:hidden">
        {c.rows.map((row, index) => (
          <li
            key={row.feature}
            className={clsx(
              'overflow-hidden rounded-2xl border border-neutral-200/90 shadow-sm dark:border-neutral-800',
              index % 2 === 0 ? 'bg-white dark:bg-neutral-900' : 'bg-neutral-50/60 dark:bg-neutral-900/50',
            )}
          >
            <p className="border-b border-neutral-200/90 px-4 py-3 text-sm font-semibold text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
              {row.feature}
            </p>
            <div className="grid gap-2 p-3">
              <MobilePlanCard planLabel={c.basicColumn} row={row} plan="basic" />
              <MobilePlanCard planLabel={c.advancedColumn} row={row} plan="advanced" highlighted />
              <MobilePlanCard planLabel={c.customColumn} row={row} plan="custom" />
            </div>
          </li>
        ))}
      </ul>

      <div className="marketing-comparison-table-wrap mt-10 hidden sm:mt-12 md:block">
        <table className="marketing-comparison-table w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              <th
                scope="col"
                className="w-[28%] border-b border-neutral-200 bg-neutral-50/80 px-4 py-4 dark:border-neutral-800 dark:bg-neutral-900/80 sm:px-5"
              />
              <th
                scope="col"
                className="border-b border-neutral-200 bg-neutral-50/80 px-4 py-4 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-400 sm:px-5"
              >
                {c.basicColumn}
              </th>
              <th
                scope="col"
                className="border-b border-teal-700/20 bg-teal-600 px-4 py-4 text-xs font-semibold uppercase tracking-wide text-white dark:border-teal-600/40 dark:bg-teal-700 sm:px-5"
              >
                {c.advancedColumn}
              </th>
              <th
                scope="col"
                className="border-b border-neutral-200 bg-neutral-50/80 px-4 py-4 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-400 sm:px-5"
              >
                {c.customColumn}
              </th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((row, index) => (
              <tr
                key={row.feature}
                className={clsx(
                  index % 2 === 0
                    ? 'bg-white dark:bg-neutral-900'
                    : 'bg-neutral-50/60 dark:bg-neutral-900/50',
                )}
              >
                <th
                  scope="row"
                  className="border-b border-neutral-100 px-4 py-4 align-top text-xs font-semibold text-neutral-800 dark:border-neutral-800 dark:text-neutral-200 sm:px-5 sm:text-sm"
                >
                  {row.feature}
                </th>
                <td className="border-b border-neutral-100 px-4 py-4 align-top dark:border-neutral-800 sm:px-5">
                  <PlanCell value={row.basic} />
                </td>
                <td className="border-b border-teal-100/80 bg-teal-50/70 px-4 py-4 align-top dark:border-teal-900/50 dark:bg-teal-950/40 sm:px-5">
                  <PlanCell value={row.advanced} />
                </td>
                <td className="border-b border-neutral-100 px-4 py-4 align-top dark:border-neutral-800 sm:px-5">
                  <PlanCell value={row.custom} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
