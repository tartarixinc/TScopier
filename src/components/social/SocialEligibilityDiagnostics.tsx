import clsx from 'clsx'
import { CheckCircle2, TriangleAlert } from 'lucide-react'
import type { SocialEligibilityDiagnostic } from '../../lib/socialEligibility'

export function SocialEligibilityDiagnostics({ diagnostics, title = 'Source eligibility checks' }: {
  diagnostics: SocialEligibilityDiagnostic[]
  title?: string
}) {
  return (
    <section className='rounded-lg border border-neutral-200 p-3 dark:border-neutral-700' aria-label={title}>
      <h3 className='text-xs font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-200'>{title}</h3>
      <ul className='mt-2 space-y-1'>
        {diagnostics.map(item => {
          const passed = item.status === 'passed'
          const Icon = passed ? CheckCircle2 : TriangleAlert
          const detail = item.nextAction ? `${item.explanation} Next: ${item.nextAction}` : item.explanation
          return (
            <li key={`${item.order}:${item.code}`} title={detail} aria-label={`${passed ? 'Passed' : 'Not passed'}: ${detail}`} className='flex min-w-0 items-center gap-2 text-xs'>
              <Icon className={clsx('h-4 w-4 shrink-0', passed ? 'text-green-500' : 'text-red-500')} aria-hidden />
              <span className='min-w-0 flex-1 truncate font-medium text-neutral-900 dark:text-neutral-50'>{item.explanation}</span>
              <span className={clsx('shrink-0 text-[10px] font-semibold uppercase', passed ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>{passed ? 'Passed' : 'Not passed'}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
