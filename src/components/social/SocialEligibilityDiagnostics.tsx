import clsx from 'clsx'
import { CheckCircle2, Clock3, TriangleAlert } from 'lucide-react'
import type { SocialEligibilityDiagnostic } from '../../lib/socialEligibility'

export function SocialEligibilityDiagnostics({ diagnostics, title = 'Source eligibility checks' }: {
  diagnostics: SocialEligibilityDiagnostic[]
  title?: string
}) {
  return (
    <section className='rounded-lg border border-neutral-200 p-3 dark:border-neutral-700' aria-label={title}>
      <h3 className='text-xs font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-200'>{title}</h3>
      <ul className='mt-2 space-y-2'>
        {diagnostics.map(item => {
          const Icon = item.status === 'passed' ? CheckCircle2 : item.status === 'pending' ? Clock3 : TriangleAlert
          return (
            <li key={`${item.order}:${item.code}`} className='flex gap-2 text-xs'>
              <Icon className={clsx('mt-0.5 h-4 w-4 shrink-0', item.status === 'passed' ? 'text-green-500' : item.status === 'pending' ? 'text-amber-500' : 'text-red-500')} aria-hidden />
              <div>
                <p className='font-medium text-neutral-900 dark:text-neutral-50'>{item.explanation}</p>
                {item.nextAction ? <p className='mt-0.5 text-neutral-600 dark:text-neutral-300'>Next: {item.nextAction}</p> : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
