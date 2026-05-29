import clsx from 'clsx'
import { Check, X } from 'lucide-react'
import { useT } from '../../../context/LocaleContext'
import type { LandingComparisonRow } from '../../../i18n/locales/landing/types'
import { appUrl } from '../../../lib/site'

export function ComparisonSection() {
  const c = useT().landing.comparison

  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
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
          <ComparisonMobileCard
            key={row.aspect}
            row={row}
            otherLabel={c.otherLabel}
            tscopierLabel={c.tscopierLabel}
            striped={index % 2 === 0}
          />
        ))}
      </ul>

      <div className="marketing-comparison-table-wrap mt-10 hidden sm:mt-12 md:block">
        <table className="marketing-comparison-table w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              <th
                scope="col"
                className="w-[26%] border-b border-neutral-200 bg-neutral-50/80 px-4 py-4 dark:border-neutral-800 dark:bg-neutral-900/80 sm:px-5"
              />
              <th
                scope="col"
                className="border-b border-neutral-200 bg-neutral-50/80 px-4 py-4 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-400 sm:px-5"
              >
                {c.otherLabel}
              </th>
              <th
                scope="col"
                className="border-b border-teal-700/20 bg-teal-600 px-4 py-4 text-xs font-semibold uppercase tracking-wide text-white dark:border-teal-600/40 dark:bg-teal-700 sm:px-5"
              >
                {c.tscopierLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((row, index) => (
              <tr
                key={row.aspect}
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
                  {row.aspect}
                </th>
                <td className="border-b border-neutral-100 px-4 py-4 align-top dark:border-neutral-800 sm:px-5">
                  <ComparisonCell negative>{row.other}</ComparisonCell>
                </td>
                <td className="border-b border-teal-100/80 bg-teal-50/70 px-4 py-4 align-top dark:border-teal-900/50 dark:bg-teal-950/40 sm:px-5">
                  <ComparisonCell positive>{row.tscopier}</ComparisonCell>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 flex justify-center sm:mt-10">
        <a
          href={appUrl('/signup')}
          className="inline-flex items-center justify-center rounded-xl bg-teal-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-700 dark:bg-teal-500 dark:hover:bg-teal-600"
        >
          {c.cta}
        </a>
      </div>
    </section>
  )
}

function ComparisonMobileCard({
  row,
  otherLabel,
  tscopierLabel,
  striped,
}: {
  row: LandingComparisonRow
  otherLabel: string
  tscopierLabel: string
  striped: boolean
}) {
  return (
    <li
      className={clsx(
        'overflow-hidden rounded-2xl border border-neutral-200/90 shadow-sm dark:border-neutral-800',
        striped ? 'bg-white dark:bg-neutral-900' : 'bg-neutral-50/60 dark:bg-neutral-900/50',
      )}
    >
      <p className="border-b border-neutral-200/90 px-4 py-3 text-sm font-semibold text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
        {row.aspect}
      </p>
      <div className="border-b border-neutral-100 px-4 py-3.5 dark:border-neutral-800">
        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {otherLabel}
        </p>
        <ComparisonCell negative>{row.other}</ComparisonCell>
      </div>
      <div className="bg-teal-50/70 px-4 py-3.5 dark:bg-teal-950/40">
        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-400">
          {tscopierLabel}
        </p>
        <ComparisonCell positive>{row.tscopier}</ComparisonCell>
      </div>
    </li>
  )
}

function ComparisonCell({
  children,
  positive,
  negative,
}: {
  children: string
  positive?: boolean
  negative?: boolean
}) {
  return (
    <div className="flex gap-2.5">
      {positive ? (
        <Check
          className="mt-0.5 h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400"
          strokeWidth={2.5}
          aria-hidden
        />
      ) : null}
      {negative ? (
        <X
          className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500/80 dark:text-neutral-400/90"
          strokeWidth={2.5}
          aria-hidden
        />
      ) : null}
      <span
        className={clsx(
          'text-sm leading-relaxed',
          positive && 'text-neutral-800 dark:text-neutral-100',
          negative && 'text-neutral-600 dark:text-neutral-400',
        )}
      >
        {children}
      </span>
    </div>
  )
}
